/**
 * pi-bgrun — pi extension that runs long shell commands detached in the
 * background and wakes the live agent session on completion.
 *
 * Phase 0 spike: minimal bgrun tool + exit→wake. De-risks the core assumption
 * that pi.sendUserMessage from a child_process exit callback triggers a live
 * turn. Phase 1 adds bgstatus/bgtail/bgclean tools, appendEntry persistence,
 * the status widget, and notify.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// Exit marker appended to every log so the file is self-describing: the exit
// code survives pi restarting. `;` (not `&&`) ensures the printf runs even when
// the command fails. Never use `set -e` in the wrapper.
const EXIT_MARKER = "__BGRUN_EXIT__=";

interface JobRecord {
  id: string;
  pid: number;
  cmd: string;
  started: number;
  logPath: string;
  exitedAt?: number;
  exitCode?: number;
  child: ReturnType<typeof spawn>;
  ctx: ExtensionContext; // captured at tool-call time for isIdle() in the exit handler
}

interface BgStatusDetails {
  id?: string;
  state?: string;
  exitCode?: number;
  cmd?: string;
  count?: number;
  recovered?: boolean;
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, JobRecord>();
  const jobsDir = process.env.PI_BGRUN_DIR || join(homedir(), ".pi-bgrun", "jobs");

  function makeSlug(command: string): string {
    // Lowercase, strip path separators, replace non-alnum with -, truncate.
    const raw = command.toLowerCase().replace(/[/\\.-]+/g, " ").trim();
    const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return slug || "job";
  }

  function readLastLogLine(logPath: string, maxLen = 200): string | null {
    try {
      const content = readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) return null;
      // Skip the exit-marker line if present.
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
        throw new Error("bgrun: command is required");      }

      mkdirSync(jobsDir, { recursive: true });

      const slug = makeSlug(command);
      const ts = Math.floor(Date.now() / 1000);
      const id = `${slug}-${ts}-${process.pid}`;
      const logPath = join(jobsDir, `${id}.log`);

      // Open the log fd synchronously before spawn so a fast job can't race.
      const logFd = openSync(logPath, "w");

      // Wrap so the shell writes the exit code as a trailing marker line on the log.
      // `;` ensures the printf runs even when the command fails. No `set -e`.
      const wrapped = `${command}; ec=$?; printf '\\n${EXIT_MARKER}%d\\n' "$ec"; exit $ec`;

      const child = spawn("sh", ["-c", wrapped], {
        stdio: ["ignore", logFd, logFd], // child writes log directly via its own fd
        detached: true, // survives pi crashing
      });
      child.unref(); // don't keep pi's event loop alive on the child's account

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

      // Close the parent's copy of the log fd — the child inherited its own copy
      // on fork, so the log keeps writing even after we close ours.
      closeSync(logFd);

      // ── exit handler: record exit code + wake the agent ─────────────────────
      child.on("exit", (code, signal) => {
        const rec = jobs.get(id);
        if (!rec) return; // unknown job (e.g. after session switch) — skip
        rec.exitedAt = Date.now();
        rec.exitCode = code ?? -1;

        // Prefer the ChildProcess exit arg; fall back to parsing the log marker
        // (covers the case where `code` is null due to a signal).
        const exitCode = code ?? parseExitFromLog(logPath) ?? -1;
        const exitStr = exitCode >= 0 ? String(exitCode) : `signal ${signal ?? "?"}`;
        const exitEmoji = exitCode === 0 ? "✅" : "❌";
        const lastLine = readLastLogLine(logPath);

        let wake = `${exitEmoji} Background job \`${id}\` finished (exit ${exitStr}).\n`;
        wake += `Command: ${command}\n`;
        if (lastLine) wake += `Last output: ${lastLine}\n`;
        wake += `Review the result now: call \`bgtail\` with this job id to see the output, summarize pass/fail, and continue the task that depended on it.`;

        // Wake the agent. sendUserMessage() with no options only works when idle;
        // followUp only works while processing. Branch on isIdle(). The ctx is
        // captured at tool-call time; it may go stale after a session switch, in
        // which case isIdle() throws and we fall through to a best-effort followUp.
        try {
          if (rec.ctx.isIdle()) {
            pi.sendUserMessage(wake);
          } else {
            pi.sendUserMessage(wake, { deliverAs: "followUp" });
          }
        } catch (err) {
          // Stale ctx (session switched) or other failure — best-effort retry.
          try {
            pi.sendUserMessage(wake, { deliverAs: "followUp" });
          } catch (e2) {
            console.error(`[pi-bgrun] wake failed for job ${id}:`, (e2 as Error).message);
          }
        }
      });

      child.on("error", (err) => {
        console.error(`[pi-bgrun] spawn error for job ${id}:`, err.message);
        jobs.delete(id);
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
    async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: BgStatusDetails; isError?: boolean }> {
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
        // Not in memory — try the log file (post-restart recovery).
        const logPath = join(jobsDir, `${id}.log`);
        try {
          const exit = parseExitFromLog(logPath);
          const state = exit !== null ? "done" : "running";
          return {
            content: [{ type: "text", text: `${id}: ${state}${exit !== null ? ` exit=${exit}` : ""} (recovered from log)\n  log: ${logPath}` }],
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
      // Scan the jobs dir for logs not in memory (e.g. after restart).
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
}
