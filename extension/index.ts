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
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";

// Exit marker appended to every log so the file is self-describing: the exit
// code survives pi restarting. `;` (not `&&`) ensures the printf runs even when
// the command fails. Never use `set -e` in the wrapper.
const EXIT_MARKER = "__BGRUN_EXIT__=";

const DEFAULT_CLEANUP_DAYS = 7;
const STALE_POLL_MS = 30_000; // re-check interval for jobs with no live child handle
const GLOBAL_JOBS_DIR = join(homedir(), ".pi-bgrun", "jobs");

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
  // True when jobsDir came from a RELATIVE path resolved against the project
  // root (project-local logs). Only then does bgrun auto-ignore the dir in
  // .git/info/exclude — an absolute dir is the user's explicit choice.
  jobsDirProjectLocal: boolean;
  // Adopt other sessions' running jobs (found in the shared jobs dir) into
  // this session's widget and job list. Default false — most sessions don't
  // want unrelated jobs from other projects cluttering the widget.
  adoptForeignJobs: boolean;
  // Include finished jobs in bgstatus listings by default. Default false —
  // completed jobs are noise; ask for them explicitly (bgstatus includeDone).
  showCompletedJobs: boolean;
  // Log retention for cleanup (auto-sweeps and the bgclean default).
  cleanupDays: number;
  // Auto-sweep the WHOLE shared jobs dir at session boundaries for orphans —
  // finished (exit marker or dead pid) logs older than cleanupDays from
  // sessions that crashed or are never resumed again. Running jobs are always
  // pid-protected. Throttled to once per cleanupDays via a .last-clean marker.
  // Default true — without it, orphaned logs accumulate forever. Set false to
  // keep every sweep session-scoped (then only `bgclean all` touches foreign
  // logs).
  globalAutoClean: boolean;
}

interface BgrunConfigFile {
  jobsDir?: unknown;
  adoptForeignJobs?: unknown;
  showCompletedJobs?: unknown;
  cleanupDays?: unknown;
  globalAutoClean?: unknown;
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

// ── Project-local jobs dir ──────────────────────────────────────────────────
//
// A RELATIVE `jobsDir` (from any config layer, or PI_BGRUN_DIR) opts into
// project-local logs: it resolves against the session's project root, so logs
// land inside the workspace. That keeps them within the project sandbox —
// analysis tools confined to the project root (e.g. context-mode's
// ctx_execute_file/ctx_index) can then process whole logs without flooding
// context. Absolute paths behave exactly as in older versions
// (migration-safe), and with no recognizable project root a relative path
// falls back to the global dir instead of scattering logs across whatever
// directory pi happened to start in.

function isProjectRootLike(dir: string): boolean {
  // Cheap heuristic: a directory holding .git or pi's config dir is a project.
  return (
    existsSync(join(dir, ".git")) || existsSync(join(dir, CONFIG_DIR_NAME))
  );
}

export function resolveJobsDirPath(
  raw: string | undefined,
  ctx?: { cwd?: string },
): { dir: string; projectLocal: boolean } {
  if (!raw) return { dir: GLOBAL_JOBS_DIR, projectLocal: false };
  if (isAbsolute(raw)) return { dir: raw, projectLocal: false };
  const root = ctx?.cwd ?? process.cwd();
  if (!root || !isProjectRootLike(root)) {
    return { dir: GLOBAL_JOBS_DIR, projectLocal: false };
  }
  return { dir: join(root, raw), projectLocal: true };
}

// Auto-ignore a project-local jobs dir in git so logs never pollute
// `git status`: appends the dir pattern to the enclosing repo's
// .git/info/exclude (local-only — the tracked .gitignore is never touched).
// Memoized per dir; every step is best-effort and must never fail a bgrun.
const gitExcludedDirs = new Set<string>();

export function ensureGitExcluded(jobsDir: string): void {
  if (gitExcludedDirs.has(jobsDir)) return;
  gitExcludedDirs.add(jobsDir); // set first — best-effort, never retry-spam
  try {
    // Walk up from jobsDir to the enclosing work tree.
    let cur = jobsDir;
    for (;;) {
      const dot = join(cur, ".git");
      if (existsSync(dot)) {
        appendExcludePattern(cur, dot, jobsDir);
        return;
      }
      const parent = dirname(cur);
      if (parent === cur) return; // filesystem root — not inside a work tree
      cur = parent;
    }
  } catch {
    // best-effort — ignore hygiene must never break job creation
  }
}

function appendExcludePattern(
  repoRoot: string,
  dotGit: string,
  jobsDir: string,
): void {
  if (jobsDir === repoRoot) return; // can't exclude the whole repo
  // `.git` is a directory in a normal checkout, or a file pointing at the
  // real git dir in linked worktrees (git worktree add) and submodules.
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(\S+)/);
    if (!m) return;
    gitDir = m[1];
  }
  const pattern = relative(repoRoot, jobsDir).split(sep).join("/") + "/";
  const excludePath = join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    // no exclude file yet — we'll create it
  }
  if (existing.split("\n").some((l) => l.trim() === pattern)) return;
  mkdirSync(join(gitDir, "info"), { recursive: true });
  appendFileSync(
    excludePath,
    `\n# pi-bgrun job logs (auto-added)\n${pattern}\n`,
  );
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
  const globalCleanFile =
    typeof merged.globalAutoClean === "boolean"
      ? merged.globalAutoClean
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
  const { dir: jobsDir, projectLocal: jobsDirProjectLocal } =
    resolveJobsDirPath(process.env.PI_BGRUN_DIR || dirFile, ctx);
  return {
    jobsDir,
    jobsDirProjectLocal,
    adoptForeignJobs:
      parseBoolEnv(process.env.PI_BGRUN_FOREIGN_JOBS) ?? foreignFile ?? false,
    showCompletedJobs:
      parseBoolEnv(process.env.PI_BGRUN_SHOW_COMPLETED) ??
      completedFile ??
      false,
    cleanupDays: daysEnv ?? daysFile ?? DEFAULT_CLEANUP_DAYS,
    globalAutoClean:
      parseBoolEnv(process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN) ??
      globalCleanFile ??
      true,
  };
}

// Widget "since" formatting: time-only when the job started today; otherwise
// include the date (and the year too when it differs) — a job that has been
// running since a previous day shouldn't render as if it started today at
// that time. `now` is injectable for deterministic tests.
export function formatSince(started: number, now: number = Date.now()): string {
  const d = new Date(started);
  const n = new Date(now);
  const time = d.toLocaleTimeString([], { hour12: false });
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) return time;
  if (d.getFullYear() === n.getFullYear()) {
    const md = d.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${md} ${time}`;
  }
  const ymd = d.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${ymd} ${time}`;
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
  // Poller for stale job records — anything running with no live ChildProcess
  // handle (adopted foreign jobs + jobs reconstructed from transcript entries
  // after a restart). No exit event exists for those, so their logs/pids are
  // re-checked on an interval instead.
  let stalePoller: ReturnType<typeof setInterval> | undefined;

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
    revalidateStaleJobs();
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
      const startedAt = formatSince(rec.started);
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

  // Session-scoped sweep: remove THIS session's finished job logs older than
  // `days`. Only looks at the in-memory Map (which, after reconstruction, is
  // exactly this session's lineage) — other sessions' logs are never touched.
  // Running jobs are always skipped. Cheap (a handful of stats), so it runs
  // unthrottled at session boundaries.
  function cleanSessionJobs(
    days: number,
    ctx?: ExtensionContext,
  ): { removed: number; kept: number; skippedRunning: number } {
    const result = { removed: 0, kept: 0, skippedRunning: 0 };
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const rec of jobs.values()) {
      if (rec.exitCode === undefined) {
        result.skippedRunning++;
        continue;
      }
      let st;
      try {
        st = statSync(rec.logPath);
      } catch {
        continue; // already gone
      }
      if (st.mtimeMs > cutoff) {
        result.kept++;
        continue;
      }
      try {
        unlinkSync(rec.logPath);
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

  // Auto-clean at session boundaries. Two parts:
  //  1. Session-scoped sweep — this session's old logs only; cheap,
  //     unthrottled.
  //  2. Global orphan sweep (default on; disable via globalAutoClean: false /
  //     PI_BGRUN_GLOBAL_AUTO_CLEAN=0) — the whole shared jobs dir, removing
  //     FINISHED logs (exit marker, or dead pid) older than cleanupDays. This
  //     is what keeps orphans from crashed / never-resumed sessions from
  //     accumulating: a week-old finished log is garbage under the same
  //     retention the owning session would apply itself, and running jobs are
  //     always pid-protected. Throttled to one sweep per cleanupDays via a
  //     .last-clean marker so restart-heavy workflows don't re-sweep on every
  //     launch.
  function autoCleanJobs(ctx: ExtensionContext): void {
    const cfg = resolveConfig(ctx);
    cleanSessionJobs(cfg.cleanupDays, ctx);
    if (!cfg.globalAutoClean) return;
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

  // Re-check stale job records — anything running with no live ChildProcess
  // handle (rec.child unset): adopted foreign jobs, and jobs reconstructed
  // from transcript entries after a restart. None of these get an exit event,
  // so the exit marker in the log (or a dead pid) is the only completion
  // signal. Without this they render as "running" forever — e.g. a job that
  // finished while pi was down reconstructs as a zombie on every resume.
  //  - Adopted jobs are dropped from the registry entirely (not this
  //    session's history; the log on disk still covers id lookup + cleanup).
  //  - Reconstructed jobs ARE this session's history: mark them done and
  //    append a done entry so future resumes reconstruct them as done too.
  function revalidateStaleJobs(): void {
    for (const [id, rec] of jobs) {
      if (rec.child || rec.exitCode !== undefined) continue;
      let exit = parseExitFromLog(rec.logPath);
      if (exit === null && rec.pid > 0 && !isRunningPid(rec.pid)) {
        // pid gone with no marker — killed/crashed before the wrapper could write it,
        // or the log was already cleaned up
        exit = -1;
      }
      if (exit === null) continue; // still genuinely running
      if (rec.adopted) {
        jobs.delete(id);
      } else {
        rec.exitCode = exit;
        rec.exitedAt = Date.now();
        pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
          id: rec.id,
          pid: rec.pid,
          cmd: rec.cmd,
          name: rec.name,
          started: rec.started,
          logPath: rec.logPath,
          state: "done",
          exitCode: exit >= 0 ? exit : undefined,
          exitedAt: rec.exitedAt,
        });
      }
    }
  }

  function hasUnsupervisedRunning(): boolean {
    for (const rec of jobs.values()) {
      if (!rec.child && rec.exitCode === undefined) return true;
    }
    return false;
  }

  function ensureStalePoller(ctx: ExtensionContext): void {
    if (stalePoller !== undefined || !hasUnsupervisedRunning()) return;
    stalePoller = setInterval(() => {
      revalidateStaleJobs();
      updateWidget(ctx);
      if (!hasUnsupervisedRunning()) stopStalePoller();
    }, STALE_POLL_MS);
    stalePoller.unref();
  }

  function stopStalePoller(): void {
    if (stalePoller !== undefined) {
      clearInterval(stalePoller);
      stalePoller = undefined;
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
        // A done entry is authoritative even when exitCode is missing (jobs
        // killed by a signal persist exitCode: undefined) — without the state
        // check those reconstruct as "running" zombies on every resume.
        const isDone = d.state === "done" || d.exitCode !== undefined;
        jobs.set(d.id, {
          id: d.id,
          pid: d.pid,
          cmd: d.cmd,
          name: d.name,
          started: d.started,
          logPath: d.logPath,
          exitedAt: d.exitedAt,
          exitCode: isDone ? (d.exitCode ?? -1) : undefined,
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
    }

    // Show the widget if anything is now running. revalidateStaleJobs()
    // inside clears zombies — reconstructed jobs that finished while pi was
    // down — before they ever render. Then start the stale poller for
    // anything still genuinely running without a child handle (also gives
    // resumed sessions live tracking of their still-running jobs).
    updateWidget(ctx);
    ensureStalePoller(ctx);
    // Auto-cleanup of old logs, throttled to one sweep per cleanupDays via a
    // marker in the jobs dir (see autoCleanJobs). Also runs on session_shutdown.
    autoCleanJobs(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopStalePoller();
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
      "Never cat or Read a full bgrun log — bgtail returns a condensed peek (ANSI stripped, repeats collapsed, ~8KB cap); use ctx_execute_file on the log path only when the condensed tail is insufficient.",
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

      const cfg = resolveConfig(ctx);
      // Project-local logs are auto-ignored in .git/info/exclude (best-effort)
      // so they never pollute `git status`. Absolute dirs are left untouched.
      if (cfg.jobsDirProjectLocal) ensureGitExcluded(cfg.jobsDir);
      const jobsDir = cfg.jobsDir;
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

  // ── Log condenser: ANSI strip, per-line cap, collapse runs, total budget ────
  // Keeps bgtail output small enough that a "quick peek" never floods context:
  // colored test output often carries 2-3x its text size in ANSI escapes, and
  // one unbounded line (minified bundle, base64 blob) can blow the whole budget.
  const ANSI_RE =
    /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><]/g;
  const LINE_CAP = 2000; // chars per line after stripping
  const TOTAL_CAP = 8000; // chars for the whole bgtail result

  function condenseLogLines(
    lines: string[],
    opts: { raw?: boolean } = {},
  ): { text: string; truncated: string[] } {
    const notes: string[] = [];
    if (opts.raw) return { text: lines.join("\n"), truncated: notes };
    let stripped = 0;
    let cappedLines = 0;
    const clean = lines.map((l) => {
      if (ANSI_RE.test(l)) {
        stripped++;
        l = l.replace(ANSI_RE, "");
      }
      return l;
    });
    ANSI_RE.lastIndex = 0;
    // collapse runs of 3+ identical lines (spinner frames, retry spam)
    const collapsed: { text: string; count: number }[] = [];
    let runs = 0;
    for (const l of clean) {
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.text === l) {
        prev.count++;
        if (prev.count === 3) runs++;
      } else {
        collapsed.push({ text: l, count: 1 });
      }
    }
    const out: string[] = [];
    let total = 0;
    for (const c of collapsed) {
      let line = c.count >= 3 ? `${c.text}  [x${c.count}]` : c.text;
      if (line.length > LINE_CAP) {
        line = line.slice(0, LINE_CAP) + ` …[+${line.length - LINE_CAP} chars]`;
        cappedLines++;
      }
      total += line.length + 1;
      if (total > TOTAL_CAP) {
        notes.push(
          `output capped at ${TOTAL_CAP} chars — ${lines.length} raw lines total; raise \`lines\`, use \`raw: true\`, or run ctx_execute_file on the log for whole-log analysis`,
        );
        break;
      }
      out.push(line);
    }
    if (stripped > 0)
      notes.push(
        `${stripped} ANSI escape sequence${stripped === 1 ? "" : "s"} stripped`,
      );
    if (runs > 0)
      notes.push(`${runs} repeated-line run${runs === 1 ? "" : "s"} collapsed`);
    if (cappedLines > 0)
      notes.push(
        `${cappedLines} long line${cappedLines === 1 ? "" : "s"} truncated to ${LINE_CAP} chars`,
      );
    return { text: out.join("\n"), truncated: notes };
  }

  // ── bgtail: read last N lines of a job's log, condensed for context ────────

  // Shared by the bgtail tool (agent-facing) and the /bgtail slash command
  // (human-facing).
  async function bgtailCore(
    params: { id: string; lines?: number; raw?: boolean },
    ctx?: ExtensionContext,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
    isError?: boolean;
  }> {
    const { id, lines = 40, raw = false } = params;
    if (!id) throw new Error("bgtail: id is required");
    // Prefer this session's record: its logPath stays correct even if the
    // config (and thus the resolved jobs dir) changes mid-session — e.g. a
    // user switching to project-local logs right after upgrading.
    const logPath =
      jobs.get(id)?.logPath ?? join(resolveConfig(ctx).jobsDir, `${id}.log`);
    try {
      const content = readFileSync(logPath, "utf8");
      const all = content
        .split("\n")
        .filter((l) => !l.startsWith(EXIT_MARKER) && l.trim().length > 0);
      const tail = all.slice(-lines);
      const { text, truncated } = condenseLogLines(tail, { raw });
      const notes = truncated.length > 0 ? `\n\n(${truncated.join("; ")})` : "";
      return {
        content: [{ type: "text", text: text + notes || "(empty log)" }],
        details: {
          id,
          linesShown: tail.length,
          logPath,
          notFound: false,
          condensed: !raw,
          ...(truncated.length > 0 ? { condenserNotes: truncated } : {}),
        },
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
  }

  pi.registerTool({
    name: "bgtail",
    label: "Tail Background Log",
    description:
      "Print the last N lines of a background job's log (default 40), condensed for context: ANSI escapes stripped, repeated lines collapsed, long lines truncated, output capped (~8KB). Strips the exit-marker line. Pass raw: true for unprocessed output; use ctx_execute_file on the log path for whole-log failure analysis.",
    promptSnippet: "Read the last N lines of a bgrun job's log",
    parameters: Type.Object({
      id: Type.String({
        description: "Job id (from bgrun's 'started: <id>' response)",
      }),
      lines: Type.Optional(
        Type.Number({ description: "Number of lines to show (default 40)" }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "Skip condensing (ANSI strip, collapse, caps) and return raw text",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return bgtailCore(params, ctx);
    },
  });

  // ── bgstatus: list jobs (in-memory while alive; dir scan after restart) ─────

  // Shared by the bgstatus tool (agent-facing) and the /bgstatus slash command
  // (human-facing).
  async function bgstatusCore(
    params: { id?: string; includeDone?: boolean },
    ctx: ExtensionContext,
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
        const exit = rec.exitCode === undefined ? "" : ` exit=${rec.exitCode}`;
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
    revalidateStaleJobs();
    updateWidget(ctx);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const [jid, rec] of jobs) {
      seen.add(jid);
      if (rec.exitCode === undefined || showDone) {
        const state = rec.exitCode === undefined ? "running" : "done";
        const exit = rec.exitCode === undefined ? "" : ` exit=${rec.exitCode}`;
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
        `  (${hiddenOnDisk} more job log(s) on disk — pass includeDone to list, bgclean all to prune)`,
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
  }

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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return bgstatusCore(params, ctx);
    },
  });

  // ── bgclean: remove old job logs ───────────────────────────────────────────

  // ── bgclean: remove old job logs ──────────────────────────────────────

  // Shared by the bgclean tool (agent-facing) and the /bgclean slash command
  // (human-facing).
  async function bgcleanCore(
    params: { days?: number; all?: boolean },
    ctx?: ExtensionContext,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: { removed: number; kept: number; skippedRunning: number };
  }> {
    const cfg = resolveConfig(ctx);
    const { days = cfg.cleanupDays, all = false } = params;
    if (typeof days !== "number" || days < 0 || !Number.isFinite(days)) {
      throw new Error(
        `bgclean: days must be a non-negative number, got ${days}`,
      );
    }
    let result;
    if (all) {
      result = cleanOldJobs(days, cfg.jobsDir, ctx);
      // A manual global clean refreshes the throttle marker so the next
      // auto-sweep doesn't immediately redo this work.
      try {
        mkdirSync(cfg.jobsDir, { recursive: true });
        writeFileSync(join(cfg.jobsDir, ".last-clean"), String(Date.now()));
      } catch {
        // best-effort
      }
    } else {
      // Session-scoped by default: bg* commands apply to the current
      // session's jobs only.
      result = cleanSessionJobs(days, ctx);
    }
    const scope = all ? "all sessions" : "this session";
    const summary = `removed ${result.removed} job log(s) (${scope}), kept ${result.kept}${result.skippedRunning > 0 ? `, skipped ${result.skippedRunning} running` : ""}`;
    return {
      content: [{ type: "text", text: summary }],
      details: result,
    };
  }

  pi.registerTool({
    name: "bgclean",
    label: "Clean Old Background Jobs",
    description:
      "Remove old background job logs from disk. Default scope: THIS session's jobs only (other sessions' logs are " +
      "untouched). Pass all: true to sweep the whole shared jobs dir. Retention: cleanupDays config (default 7 days). " +
      "Never removes a running job's log. Prints a summary of what was removed vs kept.",
    promptSnippet:
      "Remove old bgrun job logs (this session by default; all: true for every session's)",
    parameters: Type.Object({
      days: Type.Optional(
        Type.Number({
          description: "Remove logs older than this many days (default 7)",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Sweep the whole shared jobs dir (all sessions' logs), not just this session's (default false)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return bgcleanCore(params, ctx);
    },
  });

  // ── Slash commands: human-facing mirrors of the read/clean tools ───────────
  //
  // pi.registerTool registers AGENT tools; slash commands need a separate
  // pi.registerCommand registration. These let the human check jobs or prune
  // logs directly from the TUI without asking the agent. /bgrun is
  // deliberately NOT a command — starting jobs (and reacting to their wakes)
  // is the agent's workflow.

  pi.registerCommand("bgstatus", {
    description: "Background jobs: status (/bgstatus [id] [done])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const includeDone = tokens.some((t) =>
        ["done", "all"].includes(t.toLowerCase()),
      );
      const id = tokens.find((t) => !["done", "all"].includes(t.toLowerCase()));
      const res = await bgstatusCore(
        { id, includeDone: includeDone || undefined },
        ctx,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(res.content[0].text, res.isError ? "error" : "info");
      }
    },
  });

  pi.registerCommand("bgtail", {
    description: "Background jobs: tail a log (/bgtail <id> [lines])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const id = tokens[0];
      if (!id) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /bgtail <job-id> [lines]", "error");
        }
        return;
      }
      const n = Number(tokens[1]);
      const res = await bgtailCore(
        { id, lines: Number.isFinite(n) && n > 0 ? n : undefined },
        ctx,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(res.content[0].text, res.isError ? "error" : "info");
      }
    },
  });

  pi.registerCommand("bgclean", {
    description: "Background jobs: remove old logs (/bgclean [days] [all])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const tokens = (args ?? "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const daysToken = Number(tokens.find((t) => /^\d+(\.\d+)?$/.test(t)));
      const all = tokens.includes("all");
      try {
        const res = await bgcleanCore(
          { days: Number.isFinite(daysToken) ? daysToken : undefined, all },
          ctx,
        );
        if (ctx.hasUI) {
          ctx.ui.notify(res.content[0].text, "info");
        }
      } catch (err) {
        if (ctx.hasUI) {
          ctx.ui.notify(String(err), "error");
        }
      }
    },
  });
}
