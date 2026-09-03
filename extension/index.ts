/**
 * pi-bgrun — pi extension that runs long shell commands detached in the
 * background and wakes the live agent session on completion.
 *
 * Architecture:
 * - In-process spawn via child_process.spawn with stdio redirected to a log file
 *   (detached + unref so the job survives pi crashing).
 * - The child wraps the command to append a trailing __BGRUN_EXIT__=N marker,
 *   making the log self-describing — exit codes survive pi restarting.
 * - Completion is the child 'exit' event, not a poller. The exit handler wakes
 *   the agent via pi.sendUserMessage (triggers a turn when idle; followUp when busy).
 * - Job records persist via pi.appendEntry (survives same-session restart,
 *   renders as a card in the transcript, does NOT enter LLM context).
 * - Live status widget above the editor while jobs are running.
 * - Desktop toast (ctx.ui.notify) on completion for the human.
 *
 * Three-tier state degradation:
 * 1. In-memory Map (fast path while alive) — instant bgstatus, live exit→wake.
 * 2. appendEntry reconstruction (same-session restart) — session_start rebuilds
 *    the Map from bgrun-job entries.
 * 3. Filesystem scan (cross-session, cross-restart, cross-worktree) — the jobs
 *    dir is the permanent truth: filename→pid, log→exit code, kill -0→liveness.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
  openSync,
  closeSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Exit marker appended to every log so the file is self-describing: the exit
// code survives pi restarting. `;` (not `&&`) ensures the printf runs even when
// the command fails. Never use `set -e` in the wrapper.
const EXIT_MARKER = "__BGRUN_EXIT__=";

const AUTO_CLEANUP_DAYS = 14;
const DEFAULT_CLEANUP_DAYS = 7;

interface JobRecord {
  id: string;
  pid: number;
  cmd: string;
  started: number;
  logPath: string;
  exitedAt?: number;
  exitCode?: number;
  child?: ReturnType<typeof spawn>;
  ctx: ExtensionContext; // captured at tool-call time for isIdle() in the exit handler
}

// Shape persisted via pi.appendEntry — survives same-session restart, renders
// as a transcript card, does NOT enter LLM context.
interface BgrunJobEntryData {
  id: string;
  pid: number;
  cmd: string;
  started: number;
  logPath: string;
  state: "running" | "done";
  exitCode?: number;
  exitedAt?: number;
}

interface BgStatusDetails {
  id?: string;
  state?: string;
  exitCode?: number;
  cmd?: string;
  count?: number;
  recovered?: boolean;
}

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, JobRecord>();
  const jobsDir = process.env.PI_BGRUN_DIR || join(homedir(), ".pi-bgrun", "jobs");

  // ── Helpers ───────────────────────────────────────────────────────────────

  function makeSlug(command: string): string {
    const raw = command.toLowerCase().replace(/[/\\.-]+/g, " ").trim();
    const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return slug || "job";
  }

  function readLastLogLine(logPath: string, maxLen = 200): string | null {
    try {
      const content = readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) return null;
      const real = lines.filter((l) => !l.startsWith(EXIT_MARKER));
      const last = real[real.length - 1] ?? lines[lines.length - 1];
      return last.length > maxLen ? last.slice(0, maxLen) + "…" : last;
    } catch {
      return null;
    }
  }

  function parseExitFromLog(logPath: string): number | null {
    try {
      const content = readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter((l) => l.startsWith(EXIT_MARKER));
      if (lines.length === 0) return null;
      const match = lines[lines.length - 1].match(/^__BGRUN_EXIT__=(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  function pidFromId(id: string): number | null {
    // id format: <slug>-<ts>-<pid>
    const parts = id.split("-");
    const pid = parseInt(parts[parts.length - 1], 10);
    return Number.isFinite(pid) ? pid : null;
  }

  // ── Live status widget ────────────────────────────────────────────────────

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const running: JobRecord[] = [];
    for (const rec of jobs.values()) {
      if (rec.exitCode === undefined) running.push(rec);
    }
    if (running.length === 0) {
      ctx.ui.setWidget("bgrun", undefined);
      return;
    }
    const lines = [`📊 bgrun: ${running.length} running`];
    for (const rec of running) {
      const elapsed = Math.floor((Date.now() - rec.started) / 1000);
      const cmd = rec.cmd.length > 40 ? rec.cmd.slice(0, 37) + "…" : rec.cmd;
      lines.push(`  ${rec.id.slice(0, 20)}  ${cmd.padEnd(40)}  (${elapsed}s)`);
    }
    ctx.ui.setWidget("bgrun", lines);
  }

  function clearWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("bgrun", undefined);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function cleanOldJobs(days: number, ctx?: ExtensionContext): { removed: number; kept: number; skippedRunning: number } {
    const result = { removed: 0, kept: 0, skippedRunning: 0 };
    let entries: string[];
    try {
      entries = readdirSync(jobsDir);
    } catch {
      return result;
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.endsWith(".log")) continue;
      const logPath = join(jobsDir, name);
      let st;
      try {
        st = statSync(logPath);
      } catch {
        continue;
      }
      // mtime check
      if (st.mtimeMs > cutoff) {
        result.kept++;
        continue;
      }
      const id = name.slice(0, -".log".length);
      // Never clean a running job. Check in-memory Map first, then pid from filename.
      const rec = jobs.get(id);
      if (rec && rec.exitCode === undefined) {
        result.skippedRunning++;
        continue;
      }
      const pid = pidFromId(id);
      if (pid !== null && pid > 0 && isRunningPid(pid)) {
        result.skippedRunning++;
        continue;
      }
      try {
        unlinkSync(logPath);
        result.removed++;
      } catch {
        // ignore
      }
    }
    if (result.removed > 0 && ctx?.hasUI) {
      ctx.ui.notify(`bgrun: cleaned ${result.removed} old job log(s)`, "info");
    }
    return result;
  }

  // ── Entry renderer: job cards in the transcript ───────────────────────────

  pi.registerEntryRenderer<BgrunJobEntryData>("bgrun-job", (entry, { expanded }, theme) => {
    const d = entry.data ?? ({ id: "?", cmd: "", started: 0, logPath: "", state: "running" } as BgrunJobEntryData);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const icon = d.state === "done" ? (d.exitCode === 0 ? "✅" : "❌") : "🔄";
    const exitStr = d.state === "done" ? ` exit=${d.exitCode ?? "?"}` : "";
    box.addChild(new Text(`${icon} ${theme.fg("accent", "bgrun")} ${d.id}${exitStr}`, 0, 0));
    const cmdPreview = d.cmd.length > 60 ? d.cmd.slice(0, 57) + "…" : d.cmd;
    box.addChild(new Text(theme.fg("dim", `  $ ${cmdPreview}`), 0, 0));
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", `  log: ${d.logPath}`), 0, 0));
      box.addChild(new Text(theme.fg("dim", `  started: ${new Date(d.started).toLocaleString()}`), 0, 0));
      if (d.exitedAt) {
        box.addChild(new Text(theme.fg("dim", `  finished: ${new Date(d.exitedAt).toLocaleString()}`), 0, 0));
      }
    }
    return box;
  });

  // ── session_start: reconstruct Map from entries + auto-cleanup ────────────

  pi.on("session_start", async (_event, ctx) => {
    // Reconstruct the in-memory Map from this session's bgrun-job entries.
    // Only the current session's entries are visible; jobs from other sessions
    // remain discoverable via the filesystem scan in bgstatus.
    try {
      // Build a map of id → latest entry data. Entries are append-ordered, so
      // the last one for a given id wins (a running entry is followed by a done
      // entry when the job finishes).
      const latestBydId = new Map<string, BgrunJobEntryData>();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "bgrun-job") {
          const d = entry.data as BgrunJobEntryData | undefined;
          if (!d || !d.id) continue;
          latestBydId.set(d.id, d);
        }
      }
      for (const d of latestBydId.values()) {
        if (jobs.has(d.id)) continue;
        jobs.set(d.id, {
          id: d.id,
          pid: d.pid,
          cmd: d.cmd,
          started: d.started,
          logPath: d.logPath,
          exitedAt: d.exitedAt,
          exitCode: d.exitCode,
          ctx,
        });
      }
    } catch (err) {
      console.error("[pi-bgrun] session_start reconstruction failed:", (err as Error).message);
    }
    // Auto-cleanup of old logs (14-day default, fire-and-forget).
    cleanOldJobs(AUTO_CLEANUP_DAYS, ctx);
  });

  pi.on("session_shutdown", async () => {
    // Nothing to clean up — no timer; exit handlers are per-child and die with
    // the ChildProcess handles. The widget is owned by the TUI which is tearing
    // down anyway.
  });

  // ── bgrun tool ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bgrun",
    label: "Run in Background",
    description:
      "Run a long shell command detached in the background. Returns 'started: <job-id>' immediately. " +
      "You will be woken automatically when the job finishes. Use this instead of bash for any command " +
      "expected to run >30s or emit >100 lines (tests, builds, linters).",
    promptSnippet: "Run a long command detached in the background; get woken on completion",
    promptGuidelines: [
      "Use bgrun (not bash) for any command expected to run >30s or emit >100 lines — tests, builds, linters.",
      "After bgrun returns a job id, continue other work; you will be woken automatically when it finishes.",
      "Never cat or Read a full bgrun log — use bgtail for a peek or ctx_execute_file for failure analysis.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to run in the background. Run as `sh -c`, so pipes and && work.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { command } = params;
      if (!command || !command.trim()) {
        throw new Error("bgrun: command is required");
      }

      mkdirSync(jobsDir, { recursive: true });

      const slug = makeSlug(command);
      const ts = Math.floor(Date.now() / 1000);
      const id = `${slug}-${ts}-${process.pid}`;
      const logPath = join(jobsDir, `${id}.log`);

      const logFd = openSync(logPath, "w");

      const wrapped = `${command}; ec=$?; printf '\\n${EXIT_MARKER}%d\\n' "$ec"; exit $ec`;

      const child = spawn("sh", ["-c", wrapped], {
        stdio: ["ignore", logFd, logFd],
        detached: true,
      });
      child.unref();

      const record: JobRecord = {
        id,
        pid: child.pid ?? -1,
        cmd: command,
        started: Date.now(),
        logPath,
        child,
        ctx,
      };
      jobs.set(id, record);

      // Persist a bgrun-job entry (running state) — transcript card + restart recovery.
      pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
        id,
        pid: child.pid ?? -1,
        cmd: command,
        started: Date.now(),
        logPath,
        state: "running",
      });

      closeSync(logFd);

      updateWidget(ctx);

      // ── exit handler: record exit, persist done entry, wake, notify, widget ─
      child.on("exit", (code, signal) => {
        const rec = jobs.get(id);
        if (!rec) return;
        rec.exitedAt = Date.now();
        rec.exitCode = code ?? -1;
        delete rec.child; // release the handle reference

        const exitCode = code ?? parseExitFromLog(logPath) ?? -1;
        const exitStr = exitCode >= 0 ? String(exitCode) : `signal ${signal ?? "?"}`;
        const exitEmoji = exitCode === 0 ? "✅" : "❌";
        const lastLine = readLastLogLine(logPath);

        // Persist the done-state entry.
        pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
          id,
          pid: rec.pid,
          cmd: rec.cmd,
          started: rec.started,
          logPath,
          state: "done",
          exitCode: exitCode >= 0 ? exitCode : undefined,
          exitedAt: rec.exitedAt,
        });

        // Wake the agent.
        let wake = `${exitEmoji} Background job \`${id}\` finished (exit ${exitStr}).\n`;
        wake += `Command: ${command}\n`;
        if (lastLine) wake += `Last output: ${lastLine}\n`;
        wake += `Review the result now: call \`bgtail\` with this job id to see the output, summarize pass/fail, and continue the task that depended on it.`;
        try {
          if (rec.ctx.isIdle()) {
            pi.sendUserMessage(wake);
          } else {
            pi.sendUserMessage(wake, { deliverAs: "followUp" });
          }
        } catch {
          try {
            pi.sendUserMessage(wake, { deliverAs: "followUp" });
          } catch (e2) {
            console.error(`[pi-bgrun] wake failed for job ${id}:`, (e2 as Error).message);
          }
        }

        // Toast for the human.
        if (rec.ctx.hasUI) {
          rec.ctx.ui.notify(`${exitEmoji} ${command.slice(0, 50)} → exit ${exitStr}`, exitCode === 0 ? "info" : "error");
        }

        // Update/clear the widget.
        updateWidget(rec.ctx);
      });

      child.on("error", (err) => {
        console.error(`[pi-bgrun] spawn error for job ${id}:`, err.message);
        jobs.delete(id);
        updateWidget(ctx);
      });

      return {
        content: [
          {
            type: "text",
            text: `started: ${id}\n  log: ${logPath}\n  You'll be woken automatically when it finishes.`,
          },
        ],
        details: { id, logPath, pid: child.pid },
      };
    },
  });

  // ── bgtail: read last N lines of a job's log, stripping the exit marker ────

  pi.registerTool({
    name: "bgtail",
    label: "Tail Background Log",
    description:
      "Print the last N lines of a background job's log (default 40). Strips the exit-marker line. " +
      "Use this for a quick peek at results; use ctx_execute_file on the log path for whole-log failure analysis.",
    promptSnippet: "Read the last N lines of a bgrun job's log",
    parameters: Type.Object({
      id: Type.String({ description: "Job id (from bgrun's 'started: <id>' response)" }),
      lines: Type.Optional(Type.Number({ description: "Number of lines to show (default 40)" })),
    }),
    async execute(_toolCallId, params) {
      const { id, lines = 40 } = params;
      if (!id) throw new Error("bgtail: id is required");
      const logPath = join(jobsDir, `${id}.log`);
      try {
        const content = readFileSync(logPath, "utf8");
        const all = content.split("\n").filter((l) => !l.startsWith(EXIT_MARKER) && l.trim().length > 0);
        const tail = all.slice(-lines);
        return {
          content: [{ type: "text", text: tail.join("\n") || "(empty log)" }],
          details: { id, linesShown: tail.length, logPath, notFound: false },
        };
      } catch {
        return {
          content: [{ type: "text", text: `No log found for job ${id} at ${logPath}` }],
          details: { id, linesShown: 0, logPath, notFound: true },
          isError: true,
        };
      }
    },
  });

  // ── bgstatus: list jobs (in-memory while alive; dir scan after restart) ─────

  pi.registerTool({
    name: "bgstatus",
    label: "Background Job Status",
    description:
      "Show status of background jobs. With an id: one job's state + exit code. Without: list all known jobs.",
    promptSnippet: "Check status of bgrun jobs",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional job id to inspect" })),
    }),
    async execute(
      _toolCallId,
      params,
    ): Promise<{ content: { type: "text"; text: string }[]; details: BgStatusDetails; isError?: boolean }> {
      const { id } = params;
      if (id) {
        const rec = jobs.get(id);
        if (rec) {
          const state = rec.exitCode !== undefined ? "done" : "running";
          const exit = rec.exitCode !== undefined ? ` exit=${rec.exitCode}` : "";
          return {
            content: [{ type: "text", text: `${id}: ${state}${exit}\n  cmd: ${rec.cmd}\n  log: ${rec.logPath}` }],
            details: { id, state, exitCode: rec.exitCode ?? undefined, cmd: rec.cmd, recovered: false },
          };
        }
        const logPath = join(jobsDir, `${id}.log`);
        try {
          const exit = parseExitFromLog(logPath);
          const state = exit !== null ? "done" : "running";
          return {
            content: [
              { type: "text", text: `${id}: ${state}${exit !== null ? ` exit=${exit}` : ""} (recovered from log)\n  log: ${logPath}` },
            ],
            details: { id, state, exitCode: exit ?? undefined, recovered: true },
          };
        } catch {
          return {
            content: [{ type: "text", text: `No job found with id ${id}` }],
            details: { id, state: "unknown" },
            isError: true,
          };
        }
      }
      // List all: merge in-memory records with a directory scan of log files.
      const lines: string[] = [];
      const seen = new Set<string>();
      for (const [jid, rec] of jobs) {
        seen.add(jid);
        const state = rec.exitCode !== undefined ? "done" : "running";
        const exit = rec.exitCode !== undefined ? ` exit=${rec.exitCode}` : "";
        lines.push(`  ${jid}: ${state}${exit}`);
      }
      try {
        for (const name of readdirSync(jobsDir)) {
          if (!name.endsWith(".log")) continue;
          const jid = name.slice(0, -".log".length);
          if (seen.has(jid)) continue;
          const logPath = join(jobsDir, name);
          const exit = parseExitFromLog(logPath);
          const state = exit !== null ? "done" : "running";
          lines.push(`  ${jid}: ${state}${exit !== null ? ` exit=${exit}` : ""} (from log)`);
        }
      } catch {
        // jobs dir doesn't exist — nothing to scan.
      }
      if (lines.length === 0) {
        return {
          content: [{ type: "text", text: "(no bgrun jobs)" }],
          details: { count: 0 },
        };
      }
      return {
        content: [{ type: "text", text: `bgrun jobs:\n${lines.join("\n")}` }],
        details: { count: lines.length },
      };
    },
  });

  // ── bgclean: remove old job logs ───────────────────────────────────────────

  pi.registerTool({
    name: "bgclean",
    label: "Clean Old Background Jobs",
    description:
      "Remove old background job logs from disk. Default: 7 days. Never removes a running job's log. " +
      "Prints a summary of what was removed vs kept.",
    promptSnippet: "Remove old bgrun job logs",
    parameters: Type.Object({
      days: Type.Optional(
        Type.Number({ description: "Remove logs older than this many days (default 7)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { days = DEFAULT_CLEANUP_DAYS } = params;
      if (typeof days !== "number" || days < 0 || !Number.isFinite(days)) {
        throw new Error(`bgclean: days must be a non-negative number, got ${days}`);
      }
      const result = cleanOldJobs(days, ctx);
      const summary = `removed ${result.removed} job log(s), kept ${result.kept}${result.skippedRunning > 0 ? `, skipped ${result.skippedRunning} running` : ""}`;
      return {
        content: [{ type: "text", text: summary }],
        details: result,
      };
    },
  });
}
