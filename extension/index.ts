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
 *    Surfaced via bgstatus by id (always) or includeDone (explicit); other
 *    sessions' RUNNING jobs are adopted into the live widget only when
 *    adoptForeignJobs is enabled.
 */

import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
  openSync,
  closeSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Exit marker appended to every log so the file is self-describing: the exit
// code survives pi restarting. `;` (not `&&`) ensures the printf runs even when
// the command fails. Never use `set -e` in the wrapper.
const EXIT_MARKER = "__BGRUN_EXIT__=";

const DEFAULT_CLEANUP_DAYS = 7;
const ADOPTED_POLL_MS = 30_000; // re-check interval for adopted (foreign) jobs

// ── Configuration ───────────────────────────────────────────────────────────
//
// Layered: defaults ← user config file ← project config file (trusted projects
// only) ← environment variables. Pi passes no first-class per-extension config
// through the ExtensionAPI, so this follows the documented pattern: the
// extension reads its own JSON config from ~/.pi/agent/pi-bgrun.json (user) and
// <cwd>/<CONFIG_DIR_NAME>/pi-bgrun.json (project, honored only when the project
// is trusted), with PI_BGRUN_* env vars as overrides.

interface BgrunConfig {
  jobsDir: string;
  // Adopt other sessions' running jobs (found in the shared jobs dir) into
  // this session's widget and job list. Default false — most sessions don't
  // want unrelated jobs from other projects cluttering the widget.
  adoptForeignJobs: boolean;
  // Include finished jobs in bgstatus listings by default. Default false —
  // completed jobs are noise; ask for them explicitly (bgstatus includeDone).
  showCompletedJobs: boolean;
  // Log retention for auto-clean sweeps and the bgclean default. Also the
  // throttle interval for auto-clean (at most one sweep per cleanupDays).
  cleanupDays: number;
}

interface BgrunConfigFile {
  jobsDir?: unknown;
  adoptForeignJobs?: unknown;
  showCompletedJobs?: unknown;
  cleanupDays?: unknown;
}

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return undefined;
}

function readConfigFile(path: string): BgrunConfigFile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return raw as BgrunConfigFile;
  } catch {
    // missing or malformed — treat as empty
  }
  return {};
}

// Resolved per call (cheap: at most two small file reads) so env/config
// changes are picked up without module reloads — and tests can isolate.
function resolveConfig(ctx?: {
  cwd?: string;
  isProjectTrusted?: () => boolean;
}): BgrunConfig {
  const user = readConfigFile(join(homedir(), ".pi", "agent", "pi-bgrun.json"));
  let project: BgrunConfigFile = {};
  try {
    if (ctx?.isProjectTrusted?.()) {
      project = readConfigFile(
        join(ctx.cwd ?? process.cwd(), CONFIG_DIR_NAME, "pi-bgrun.json"),
      );
    }
  } catch {
    // unreadable project config — ignore
  }
  const merged: BgrunConfigFile = { ...user, ...project };
  const foreignFile =
    typeof merged.adoptForeignJobs === "boolean"
      ? merged.adoptForeignJobs
      : undefined;
  const completedFile =
    typeof merged.showCompletedJobs === "boolean"
      ? merged.showCompletedJobs
      : undefined;
  const dirFile =
    typeof merged.jobsDir === "string" && merged.jobsDir
      ? merged.jobsDir
      : undefined;
  const daysFile =
    typeof merged.cleanupDays === "number" &&
    Number.isFinite(merged.cleanupDays) &&
    merged.cleanupDays > 0
      ? merged.cleanupDays
      : undefined;
  const envDays = Number(process.env.PI_BGRUN_CLEANUP_DAYS);
  const daysEnv = Number.isFinite(envDays) && envDays > 0 ? envDays : undefined;
  return {
    jobsDir:
      process.env.PI_BGRUN_DIR ||
      dirFile ||
      join(homedir(), ".pi-bgrun", "jobs"),
    adoptForeignJobs:
      parseBoolEnv(process.env.PI_BGRUN_FOREIGN_JOBS) ?? foreignFile ?? false,
    showCompletedJobs:
      parseBoolEnv(process.env.PI_BGRUN_SHOW_COMPLETED) ??
      completedFile ??
      false,
    cleanupDays: daysEnv ?? daysFile ?? DEFAULT_CLEANUP_DAYS,
  };
}

interface JobRecord {
  id: string;
  pid: number;
  cmd: string;
  name?: string; // optional human-readable label
  started: number;
  logPath: string;
  exitedAt?: number;
  exitCode?: number;
  child?: ReturnType<typeof spawn>; // absent for adopted (fs-discovered) jobs
  ctx: ExtensionContext; // captured at tool-call time for isIdle() in the exit handler
  adopted?: boolean; // true when discovered from the jobs dir (another session's job)
}

// Shape persisted via pi.appendEntry — survives same-session restart, renders
// as a transcript card, does NOT enter LLM context.
interface BgrunJobEntryData {
  id: string;
  pid: number;
  cmd: string;
  name?: string;
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
  name?: string;
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
  // Poller for adopted (foreign) jobs — they have no ChildProcess handle, so
  // no exit event; their logs/pids are re-checked on an interval instead.
  let adoptedPoller: ReturnType<typeof setInterval> | undefined;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function makeSlug(command: string): string {
    const raw = command
      .toLowerCase()
      .replace(/[/\\.-]+/g, " ")
      .trim();
    const slug = raw
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return slug || "job";
  }

  // Normalize an optional human-readable name: trim, drop blank, cap length.
  function sanitizeName(name: string | undefined): string | undefined {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, 80);
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
      const lines = content
        .split("\n")
        .filter((l) => l.startsWith(EXIT_MARKER));
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
    revalidateAdoptedJobs();
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
      const startedAt = new Date(rec.started).toLocaleTimeString([], {
        hour12: false,
      });
      const cmd = rec.cmd.length > 40 ? rec.cmd.slice(0, 37) + "…" : rec.cmd;
      const label = rec.name ? `${rec.name} · ${cmd}` : cmd.padEnd(40);
      const tag = rec.adopted ? " (adopted)" : "";
      lines.push(
        `  ${rec.id.slice(0, 20)}  ${label}  (since ${startedAt})${tag}`,
      );
    }
    ctx.ui.setWidget("bgrun", lines);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function cleanOldJobs(
    days: number,
    jobsDir: string,
    ctx?: ExtensionContext,
  ): { removed: number; kept: number; skippedRunning: number } {
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
      // Exit marker is the authoritative finished signal — check it BEFORE pid
      // liveness, so completed jobs are never mistaken for running (pid reuse
      // and shared pids made the old order keep stale jobs forever).
      const finished = parseExitFromLog(logPath) !== null;
      if (!finished) {
        // No marker yet — running only if the pid is alive.
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

  // Throttled auto-clean: runs at session_start/session_shutdown at most once
  // per cleanupDays (tracked via a .last-clean marker in the jobs dir). Manual
  // bgclean always runs and refreshes the marker. This is the "7-day timer" —
  // any session boundary after the interval fires the sweep, so long-lived
  // sessions and restart-heavy workflows both stay covered without cleaning on
  // every bgrun call.
  function autoCleanJobs(ctx: ExtensionContext): void {
    const cfg = resolveConfig(ctx);
    const markerPath = join(cfg.jobsDir, ".last-clean");
    try {
      const last = Number(readFileSync(markerPath, "utf8").trim());
      if (
        Number.isFinite(last) &&
        Date.now() - last < cfg.cleanupDays * 24 * 60 * 60 * 1000
      )
        return;
    } catch {
      // no marker yet — run the sweep
    }
    cleanOldJobs(cfg.cleanupDays, cfg.jobsDir, ctx);
    try {
      mkdirSync(cfg.jobsDir, { recursive: true });
      writeFileSync(markerPath, String(Date.now()));
    } catch {
      // best-effort
    }
  }

  // Re-check adopted (foreign) jobs: they have no exit event, so the exit
  // marker in the log (or a dead pid) is the only completion signal. Without
  // this, adopted jobs render as "running" forever even after they finish.
  // Finished adopted jobs are dropped from the in-memory registry entirely —
  // they aren't this session's history; the log stays on disk (id lookup,
  // disk note, and cleanup all still cover it). Called from the adopted poller
  // and before rendering the widget / listing jobs.
  function revalidateAdoptedJobs(): void {
    for (const [id, rec] of jobs) {
      if (!rec.adopted || rec.exitCode !== undefined) continue;
      let exit = parseExitFromLog(rec.logPath);
      if (exit === null && rec.pid > 0 && !isRunningPid(rec.pid)) {
        // pid gone with no marker — killed/crashed before the wrapper could write it
        exit = -1;
      }
      if (exit !== null) jobs.delete(id);
    }
  }

  function hasAdoptedRunning(): boolean {
    for (const rec of jobs.values()) {
      if (rec.adopted && rec.exitCode === undefined) return true;
    }
    return false;
  }

  function ensureAdoptedPoller(ctx: ExtensionContext): void {
    if (adoptedPoller !== undefined || !hasAdoptedRunning()) return;
    adoptedPoller = setInterval(() => {
      revalidateAdoptedJobs();
      updateWidget(ctx);
      if (!hasAdoptedRunning()) stopAdoptedPoller();
    }, ADOPTED_POLL_MS);
    adoptedPoller.unref();
  }

  function stopAdoptedPoller(): void {
    if (adoptedPoller !== undefined) {
      clearInterval(adoptedPoller);
      adoptedPoller = undefined;
    }
  }

  // ── Entry renderer: job cards in the transcript ───────────────────────────

  pi.registerEntryRenderer<BgrunJobEntryData>(
    "bgrun-job",
    (entry, { expanded }, theme) => {
      const d =
        entry.data ??
        ({
          id: "?",
          cmd: "",
          started: 0,
          logPath: "",
          state: "running",
        } as BgrunJobEntryData);
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      const icon = d.state === "done" ? (d.exitCode === 0 ? "✅" : "❌") : "🔄";
      const exitStr = d.state === "done" ? ` exit=${d.exitCode ?? "?"}` : "";
      const namePrefix = d.name ? `"${d.name}" ` : "";
      box.addChild(
        new Text(
          `${icon} ${theme.fg("accent", "bgrun")} ${namePrefix}${d.id}${exitStr}`,
          0,
          0,
        ),
      );
      const cmdPreview = d.cmd.length > 60 ? d.cmd.slice(0, 57) + "…" : d.cmd;
      box.addChild(new Text(theme.fg("dim", `  $ ${cmdPreview}`), 0, 0));
      if (expanded) {
        box.addChild(new Text(theme.fg("dim", `  log: ${d.logPath}`), 0, 0));
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `  started: ${new Date(d.started).toLocaleString()}`,
            ),
            0,
            0,
          ),
        );
        if (d.exitedAt) {
          box.addChild(
            new Text(
              theme.fg(
                "dim",
                `  finished: ${new Date(d.exitedAt).toLocaleString()}`,
              ),
              0,
              0,
            ),
          );
        }
      }
      return box;
    },
  );

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
          name: d.name,
          started: d.started,
          logPath: d.logPath,
          exitedAt: d.exitedAt,
          exitCode: d.exitCode,
          ctx,
        });
      }
    } catch (err) {
      console.error(
        "[pi-bgrun] session_start reconstruction failed:",
        (err as Error).message,
      );
    }

    // Adopt running jobs discovered from the jobs dir (started by other sessions).
    // Opt-in (adoptForeignJobs / PI_BGRUN_FOREIGN_JOBS=1): the jobs dir is shared
    // across every pi session on the machine, and most sessions don't want
    // unrelated jobs from other projects cluttering the widget. Adopted jobs
    // have no ChildProcess handle — no exit event, so a poller re-checks their
    // logs and pids instead, and they leave the widget once finished.
    const cfg = resolveConfig(ctx);
    const jobsDir = cfg.jobsDir;
    if (cfg.adoptForeignJobs) {
      try {
        for (const name of readdirSync(jobsDir)) {
          if (!name.endsWith(".log")) continue;
          const id = name.slice(0, -".log".length);
          if (jobs.has(id)) continue;
          const logPath = join(jobsDir, name);
          const exit = parseExitFromLog(logPath);
          if (exit !== null) continue; // finished — nothing to show in the widget
          const pid = pidFromId(id);
          if (pid === null || pid <= 0 || !isRunningPid(pid)) continue; // dead pid, marker just not written yet
          let started = Date.now();
          try {
            started = statSync(logPath).birthtimeMs;
          } catch {
            // keep fallback
          }
          jobs.set(id, {
            id,
            pid,
            cmd: "(started by another session)",
            started,
            logPath,
            ctx,
            adopted: true,
          });
        }
      } catch {
        // jobs dir doesn't exist — nothing to adopt.
      }
      ensureAdoptedPoller(ctx);
    }

    // Show the widget if anything is now running (covers adopted + reconstructed jobs).
    updateWidget(ctx);
    // Auto-cleanup of old logs, throttled to one sweep per cleanupDays via a
    // marker in the jobs dir (see autoCleanJobs). Also runs on session_shutdown.
    autoCleanJobs(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopAdoptedPoller();
    // Sweep old logs on the way out. Throttled via the .last-clean marker so
    // restart-heavy workflows don't sweep more than once per cleanupDays.
    try {
      autoCleanJobs(ctx);
    } catch {
      // best-effort — shutdown must never throw
    }
  });

  // ── bgrun tool ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bgrun",
    label: "Run in Background",
    description:
      "Run a long shell command detached in the background. Returns 'started: <job-id>' immediately. " +
      "You will be woken automatically when the job finishes. Use this instead of bash for any command " +
      "expected to run >30s or emit >100 lines (tests, builds, linters). Optionally pass `name` for a " +
      "short human-readable label used in the job id, status output, and wake messages.",
    promptSnippet:
      "Run a long command detached in the background; get woken on completion",
    promptGuidelines: [
      "Use bgrun (not bash) for any command expected to run >30s or emit >100 lines — tests, builds, linters.",
      "Give every bgrun job a short name (e.g. name: 'unit-tests') so it's recognizable in status output, the status widget, and wake messages.",
      "After bgrun returns a job id, continue other work; you will be woken automatically when it finishes.",
      "Never cat or Read a full bgrun log — use bgtail for a peek or ctx_execute_file for failure analysis.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to run in the background. Run as `sh -c`, so pipes and && work.",
      }),
      name: Type.Optional(
        Type.String({
          description:
            "Optional short human-readable label for the job (e.g. 'unit-tests', 'frontend-build'). " +
            "Used in the job id, status output, the status widget, and wake messages.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { command, name: rawName } = params;
      if (!command || !command.trim()) {
        throw new Error("bgrun: command is required");
      }
      const name = sanitizeName(rawName);

      const jobsDir = resolveConfig(ctx).jobsDir;
      mkdirSync(jobsDir, { recursive: true });

      const slug = makeSlug(name ?? command);
      const ts = Math.floor(Date.now() / 1000);
      // The id must carry the CHILD's pid (liveness checks depend on it), but the
      // log fd must exist before spawn. Create at a temp path, rename after spawn.
      const tmpPath = join(
        jobsDir,
        `.tmp-${slug}-${ts}-${Math.random().toString(36).slice(2, 8)}.log`,
      );
      let logFd: number;
      try {
        logFd = openSync(tmpPath, "w");
      } catch (err) {
        throw new Error(
          `bgrun: cannot create log file: ${(err as Error).message}`,
        );
      }
      const wrapped = `${command}; ec=$?; printf '\\n${EXIT_MARKER}%d\\n' "$ec"; exit $ec`;

      const child = spawn("sh", ["-c", wrapped], {
        stdio: ["ignore", logFd, logFd],
        detached: true,
      });
      child.unref();

      const childPid = child.pid ?? -1;
      const id = `${slug}-${ts}-${childPid}`;
      const logPath = join(jobsDir, `${id}.log`);
      try {
        renameSync(tmpPath, logPath);
      } catch (err) {
        console.error(
          `[pi-bgrun] rename to final log path failed:`,
          (err as Error).message,
        );
      }

      const record: JobRecord = {
        id,
        pid: childPid,
        cmd: command,
        name,
        started: Date.now(),
        logPath,
        child,
        ctx,
      };
      jobs.set(id, record);

      // Persist a bgrun-job entry (running state) — transcript card + restart recovery.
      pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
        id,
        pid: childPid,
        cmd: command,
        name,
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
        const exitStr =
          exitCode >= 0 ? String(exitCode) : `signal ${signal ?? "?"}`;
        const exitEmoji = exitCode === 0 ? "✅" : "❌";
        const lastLine = readLastLogLine(logPath);

        // Persist the done-state entry.
        pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
          id,
          pid: rec.pid,
          cmd: rec.cmd,
          name: rec.name,
          started: rec.started,
          logPath,
          state: "done",
          exitCode: exitCode >= 0 ? exitCode : undefined,
          exitedAt: rec.exitedAt,
        });

        // Wake the agent.
        const namePrefix = rec.name ? `"${rec.name}" ` : "";
        let wake = `${exitEmoji} Background job ${namePrefix}\`${id}\` finished (exit ${exitStr}).\n`;
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
            console.error(
              `[pi-bgrun] wake failed for job ${id}:`,
              (e2 as Error).message,
            );
          }
        }

        // Toast for the human.
        if (rec.ctx.hasUI) {
          const toastLabel = (rec.name ?? command).slice(0, 50);
          rec.ctx.ui.notify(
            `${exitEmoji} ${toastLabel} → exit ${exitStr}`,
            exitCode === 0 ? "info" : "error",
          );
        }

        // Update/clear the widget.
        updateWidget(rec.ctx);
      });

      child.on("error", (err) => {
        console.error(`[pi-bgrun] spawn error for job ${id}:`, err.message);
        jobs.delete(id);
        updateWidget(ctx);
      });

      const startedLines = [`started: ${id}`];
      if (name) startedLines.push(`  name: ${name}`);
      startedLines.push(
        `  log: ${logPath}`,
        `  You'll be woken automatically when it finishes.`,
      );
      return {
        content: [{ type: "text", text: startedLines.join("\n") }],
        details: { id, name, logPath, pid: childPid },
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
      id: Type.String({
        description: "Job id (from bgrun's 'started: <id>' response)",
      }),
      lines: Type.Optional(
        Type.Number({ description: "Number of lines to show (default 40)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id, lines = 40 } = params;
      if (!id) throw new Error("bgtail: id is required");
      const logPath = join(resolveConfig(ctx).jobsDir, `${id}.log`);
      try {
        const content = readFileSync(logPath, "utf8");
        const all = content
          .split("\n")
          .filter((l) => !l.startsWith(EXIT_MARKER) && l.trim().length > 0);
        const tail = all.slice(-lines);
        return {
          content: [{ type: "text", text: tail.join("\n") || "(empty log)" }],
          details: { id, linesShown: tail.length, logPath, notFound: false },
        };
      } catch {
        return {
          content: [
            { type: "text", text: `No log found for job ${id} at ${logPath}` },
          ],
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
      "Show status of background jobs. With an id: one job's state + exit code. Without: list this session's " +
      "running jobs (finished jobs are hidden by default — pass includeDone or set showCompletedJobs to list " +
      "them; other sessions' jobs are only listed when adoptForeignJobs is enabled).",
    promptSnippet: "Check status of bgrun jobs",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Optional job id to inspect" }),
      ),
      includeDone: Type.Optional(
        Type.Boolean({
          description:
            "Include finished jobs (and other logs on disk) in the listing",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: BgStatusDetails;
      isError?: boolean;
    }> {
      const { id } = params;
      const cfg = resolveConfig(ctx);
      const jobsDir = cfg.jobsDir;
      if (id) {
        const rec = jobs.get(id);
        if (rec) {
          const state = rec.exitCode === undefined ? "running" : "done";
          const exit =
            rec.exitCode === undefined ? "" : ` exit=${rec.exitCode}`;
          const lines = [`${id}: ${state}${exit}`];
          if (rec.name) lines.push(`  name: ${rec.name}`);
          lines.push(`  cmd: ${rec.cmd}`, `  log: ${rec.logPath}`);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              id,
              state,
              exitCode: rec.exitCode ?? undefined,
              cmd: rec.cmd,
              name: rec.name,
              recovered: false,
            },
          };
        }
        const logPath = join(jobsDir, `${id}.log`);
        try {
          const exit = parseExitFromLog(logPath);
          const state = exit === null ? "running" : "done";
          return {
            content: [
              {
                type: "text",
                text: `${id}: ${state}${exit === null ? "" : ` exit=${exit}`} (recovered from log)\n  log: ${logPath}`,
              },
            ],
            details: {
              id,
              state,
              exitCode: exit ?? undefined,
              recovered: true,
            },
          };
        } catch {
          return {
            content: [{ type: "text", text: `No job found with id ${id}` }],
            details: { id, state: "unknown" },
            isError: true,
          };
        }
      }
      // List: this session's jobs (running by default; finished only when
      // includeDone / showCompletedJobs is set), plus — when opted in — other
      // sessions' jobs from the shared jobs dir. Hidden disk logs get a
      // one-line count instead of spamming the listing.
      const showDone = params.includeDone ?? cfg.showCompletedJobs;
      revalidateAdoptedJobs();
      updateWidget(ctx);
      const lines: string[] = [];
      const seen = new Set<string>();
      for (const [jid, rec] of jobs) {
        seen.add(jid);
        if (rec.exitCode === undefined || showDone) {
          const state = rec.exitCode === undefined ? "running" : "done";
          const exit =
            rec.exitCode === undefined ? "" : ` exit=${rec.exitCode}`;
          const label = rec.name ? `${jid} — ${rec.name}` : jid;
          const from = rec.adopted ? " (adopted)" : "";
          lines.push(`  ${label}: ${state}${exit}${from}`);
        }
      }
      let hiddenOnDisk = 0;
      try {
        for (const name of readdirSync(jobsDir)) {
          if (!name.endsWith(".log")) continue;
          const jid = name.slice(0, -".log".length);
          if (seen.has(jid)) continue;
          const logPath = join(jobsDir, name);
          const exit = parseExitFromLog(logPath);
          if (exit !== null) {
            // finished log on disk (other or older session)
            if (showDone) {
              lines.push(`  ${jid}: done exit=${exit} (from log)`);
            } else {
              hiddenOnDisk++;
            }
          } else if (cfg.adoptForeignJobs) {
            // running foreign job — only surfaced when adoption is enabled
            lines.push(`  ${jid}: running (from log)`);
          } else {
            hiddenOnDisk++;
          }
        }
      } catch {
        // jobs dir doesn't exist — nothing to scan.
      }
      if (hiddenOnDisk > 0) {
        lines.push(
          `  (${hiddenOnDisk} more job log(s) on disk — pass includeDone to list, bgclean to prune)`,
        );
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
        Type.Number({
          description: "Remove logs older than this many days (default 7)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = resolveConfig(ctx);
      const { days = cfg.cleanupDays } = params;
      if (typeof days !== "number" || days < 0 || !Number.isFinite(days)) {
        throw new Error(
          `bgclean: days must be a non-negative number, got ${days}`,
        );
      }
      const result = cleanOldJobs(days, cfg.jobsDir, ctx);
      // Manual clean refreshes the throttle marker so the next auto-sweep
      // doesn't immediately redo this work.
      try {
        mkdirSync(cfg.jobsDir, { recursive: true });
        writeFileSync(join(cfg.jobsDir, ".last-clean"), String(Date.now()));
      } catch {
        // best-effort
      }
      const summary = `removed ${result.removed} job log(s), kept ${result.kept}${result.skippedRunning > 0 ? `, skipped ${result.skippedRunning} running` : ""}`;
      return {
        content: [{ type: "text", text: summary }],
        details: result,
      };
    },
  });
}
