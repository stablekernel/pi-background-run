#!/usr/bin/env bun
/**
 * measure-sessions.ts — re-derive the benchmark numbers from pi session transcripts.
 *
 * WHY THIS EXISTS
 * ---------------
 * The numbers in docs/dogfooding.md were first produced by two throwaway Python
 * profilers (`/tmp/arm_profile.py`, `/tmp/agg_arms.py`). Those scripts are gone the
 * moment the machine is, and a benchmark whose source is unreproducible is not
 * evidence — it is a claim. This is the committed port: one dependency-free CLI
 * that turns a directory of `*.jsonl` transcripts into the same per-session and
 * per-arm numbers, so anyone can re-run the comparison and check it.
 *
 * It is deliberately faithful where the accounting is meaningful and explicit
 * where it changes:
 *
 *   wallSeconds      first → last `message` entry timestamp. The session's own
 *                    clock; not wall time on the host, not the fixture's runtime.
 *   executions       suite runs the session actually STARTED: a foreground `bash`
 *                    call whose command *executes* the suite, plus every `bgrun`
 *                    handoff. `cat long-job.sh` is not an execution — the command
 *                    must invoke it. A bgrun handoff counts because the work did
 *                    happen; it is reported separately (foregroundExecutions /
 *                    handoffs) because the two arms wait for it differently.
 *   blockedSeconds   sum of the waits on those foreground suite runs. This is the
 *                    time the session could not proceed: the number the whole
 *                    comparison is about.
 *   idleSeconds      wallSeconds − blockedSeconds. Deliberately NOT the sum of
 *                    sleep/wait calls: in a bgrun session the agent is not blocked
 *                    on the suite but is still working (polling bgstatus, reading
 *                    the log), and charging that as "idle" would flatter the tool.
 *                    What is left over here is time neither spent blocked nor
 *                    avoided, whatever the agent did with it.
 *   agentSleepSeconds sum over calls whose command is a bare `sleep`/`wait`. The
 *                    throwaway profilers called this "agent-chosen idle"; it is
 *                    kept as its own column so this tool's numbers stay
 *                    cross-checkable against theirs for sessions that use it.
 *   contextChars     total characters of text/thinking the session accumulated
 *                    across all `message` entries (assistant + tool results + the
 *                    rest). What the model paid for, not what the terminal showed.
 *   diagnosticReach  whether the LAST assistant text carries
 *                    DIAGNOSTIC_MARKER_UPSTREAM / DIAGNOSTIC_MARKER_DOWNSTREAM.
 *                    For the failing fixtures that is the only measure of whether
 *                    the failure detail reached the model at all — a run can be
 *                    fast because the agent never saw what broke.
 *
 * TOLERANCE
 * ---------
 * Transcripts are append-only and not every line is a `message` (session,
 * session_info, model_change, …), and a crashed writer can leave a half-line.
 * Anything that is not a parsable `message` is skipped, never fatal: a benchmark
 * tool that dies on an unknown record would only ever measure clean runs.
 *
 * USAGE
 * -----
 *   bun scripts/measure-sessions.ts <dir-or-glob...> [--csv]
 *
 * A target is a session directory (its first `*.jsonl`, sorted, is the transcript),
 * a transcript file, or a glob. Shells expand globs, but a quoted pattern still
 * works here — expansion is built in so the invocation is reproducible either way.
 * Output is one row per session, the per-call ledger, then a median+range summary
 * per arm. Never a single aggregate: the spread IS the finding.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** "The run under test": an actual suite invocation, or the long-job script being
 * executed. Kept textually identical to the throwaway profilers so the numbers
 * refer to the same event. */
export const SUITE_PATTERN =
  /(?:\bbun test\b)|(?:(?:^|[;&|]\s*)(?:sh|bash|\.\/)\s*\S*long-job\.sh)/;

/** A call the agent chose to spend time in rather than use. */
export const IDLE_PATTERN = /^\s*(sleep|wait)\b/;

export const UPSTREAM_MARKER = "DIAGNOSTIC_MARKER_UPSTREAM";
export const DOWNSTREAM_MARKER = "DIAGNOSTIC_MARKER_DOWNSTREAM";

export type Arm = "bgrun" | "vanilla";

/** One tool call, paired with the result it produced. */
export interface CallMeasurement {
  /** Tool name exactly as the transcript records it (`bash`, `bgrun`, `read`, …). */
  tool: string;
  /** The command/id/path argument, verbatim — the "exact shell command invoked". */
  command: string;
  /** Seconds between the assistant's toolCall and its toolResult. */
  waitSeconds: number;
  /** Characters in the result's text/thinking parts. */
  resultChars: number;
  /** Running context total after this call — where it sits in the ledger. */
  cumulativeContextChars: number;
  /** True when the call shared an assistant message with an earlier toolCall, so the
   * timestamp pairs the BATCH's result with it, not the call's own. */
  batched: boolean;
  /** True when this call actually started the suite (foreground or handoff). */
  suiteExecution: boolean;
}

export interface SessionMeasurement {
  /** Directory name of the session (or the transcript's parent directory). */
  label: string;
  /** Absolute path of the transcript the numbers came from. */
  transcript: string;
  /** Inferred from the transcript: `bgrun` if it made bgrun calls, else `vanilla`. */
  arm: Arm;
  wallSeconds: number;
  /** Foreground suite runs + bgrun handoffs. */
  executions: number;
  foregroundExecutions: number;
  handoffs: number;
  blockedSeconds: number;
  idleSeconds: number;
  agentSleepSeconds: number;
  contextChars: number;
  toolCalls: number;
  calls: CallMeasurement[];
  /** Every command/id/path seen, in call order. */
  commands: string[];
  diagnosticUpstream: boolean;
  diagnosticDownstream: boolean;
}

/** Text/thinking characters a `message` entry contributes to context. */
function textLength(entry: Record<string, unknown>): number {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as { text?: unknown; thinking?: unknown };
    // `||`, not `??`: an empty `text` falls through to `thinking`, matching the
    // original profilers exactly.
    const text = record.text || record.thinking;
    if (typeof text === "string") total += text.length;
  }
  return total;
}

/** Concatenated text of one message (thinking excluded), for marker scans. */
function messageText(entry: Record<string, unknown>): string {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") out += text;
  }
  return out;
}

/** Epoch milliseconds, or null when the entry carries no usable timestamp. */
function timestampOf(entry: Record<string, unknown>): number | null {
  const raw = entry.timestamp;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Read one transcript into the raw ledger. Tolerant by construction: non-JSON
 * lines, non-`message` entries, and results with no matching call are all
 * survivable — see the TOLERANCE note in the file header.
 */
function readTranscript(transcript: string): {
  rows: Omit<CallMeasurement, "suiteExecution">[];
  wallSeconds: number;
  contextChars: number;
  lastAssistantText: string;
  sawBgrun: boolean;
} {
  const rows: Omit<CallMeasurement, "suiteExecution">[] = [];
  const pending = new Map<
    string,
    { tool: string; command: string; at: number | null }
  >();
  const batched = new Set<string>();
  let first: number | null = null;
  let last: number | null = null;
  let cumulative = 0;
  let lastAssistantText = "";
  let sawBgrun = false;

  let text: string;
  try {
    text = readFileSync(transcript, "utf8");
  } catch {
    return { rows, wallSeconds: 0, contextChars: 0, lastAssistantText, sawBgrun };
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;

    const at = timestampOf(entry);
    if (at !== null) {
      if (first === null) first = at;
      last = at;
    }
    const message = entry.message as
      | { role?: unknown; content?: unknown; toolCallId?: unknown }
      | undefined;
    const role = message?.role;

    if (role === "assistant") {
      const ids: string[] = [];
      for (const part of Array.isArray(message?.content) ? message.content : []) {
        if (typeof part !== "object" || part === null) continue;
        const call = part as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: Record<string, unknown>;
        };
        if (call.type !== "toolCall") continue;
        const args = call.arguments ?? {};
        const command = String(args.command ?? args.id ?? args.path ?? "");
        const tool = String(call.name ?? "?");
        if (tool === "bgrun") sawBgrun = true;
        const id = typeof call.id === "string" ? call.id : `${rows.length}:${ids.length}`;
        ids.push(id);
        pending.set(id, { tool, command, at });
      }
      // Everything after the first call in one assistant message resolves at the
      // batch's summary timestamp, not its own — flagged so the wait is read right.
      for (const id of ids.slice(1)) batched.add(id);
      cumulative += textLength(entry);
      const assistantText = messageText(entry);
      if (assistantText) lastAssistantText = assistantText;
      continue;
    }

    if (role === "toolResult") {
      const resultChars = textLength(entry);
      cumulative += resultChars;
      const toolCallId = message?.toolCallId;
      let matched = typeof toolCallId === "string" ? pending.get(toolCallId) : undefined;
      let matchedId = typeof toolCallId === "string" ? toolCallId : "";
      if (!matched && pending.size > 0) {
        // Interactive transcripts may omit toolCallId; pair in arrival order,
        // which is insertion order for a Map.
        matchedId = pending.keys().next().value as string;
        matched = pending.get(matchedId);
      }
      const tool = matched?.tool ?? "?";
      const command = matched?.command ?? "(unmatched)";
      const startedAt = matched?.at ?? null;
      if (matchedId) pending.delete(matchedId);
      rows.push({
        tool,
        command,
        waitSeconds:
          at !== null && startedAt !== null ? (at - startedAt) / 1000 : 0,
        resultChars,
        cumulativeContextChars: cumulative,
        batched: batched.has(matchedId),
      });
      continue;
    }

    cumulative += textLength(entry);
  }

  return {
    rows,
    wallSeconds: first !== null && last !== null ? (last - first) / 1000 : 0,
    contextChars: cumulative,
    lastAssistantText,
    sawBgrun,
  };
}

/** Measure one session directory (or transcript file) under a given label. */
export function measureSession(label: string, target: string): SessionMeasurement {
  const transcript = transcriptIn(target);
  if (transcript === null) {
    // A caller-visible zero row: a session with no suite execution still has to
    // report, so "nothing ran" is a measurement, not an omission.
    return {
      label,
      transcript: target,
      arm: "vanilla",
      wallSeconds: 0,
      executions: 0,
      foregroundExecutions: 0,
      handoffs: 0,
      blockedSeconds: 0,
      idleSeconds: 0,
      agentSleepSeconds: 0,
      contextChars: 0,
      toolCalls: 0,
      calls: [],
      commands: [],
      diagnosticUpstream: false,
      diagnosticDownstream: false,
    };
  }
  const raw = readTranscript(transcript);
  const calls: CallMeasurement[] = raw.rows.map((row) => ({
    ...row,
    suiteExecution:
      (row.tool === "bash" && SUITE_PATTERN.test(row.command)) ||
      row.tool === "bgrun",
  }));
  const foreground = calls.filter((c) => c.tool === "bash" && c.suiteExecution);
  const handoffs = calls.filter((c) => c.tool === "bgrun");
  const blockedSeconds = foreground.reduce((sum, c) => sum + c.waitSeconds, 0);
  const sleeps = calls.filter((c) => IDLE_PATTERN.test(c.command));
  return {
    label,
    transcript,
    arm: raw.sawBgrun ? "bgrun" : "vanilla",
    wallSeconds: raw.wallSeconds,
    executions: foreground.length + handoffs.length,
    foregroundExecutions: foreground.length,
    handoffs: handoffs.length,
    blockedSeconds,
    // Literal definition, not clamped: a negative difference would itself be a
    // finding (a wait timestamped outside the span) and must not be hidden as 0.
    idleSeconds: raw.wallSeconds - blockedSeconds,
    agentSleepSeconds: sleeps.reduce((sum, c) => sum + c.waitSeconds, 0),
    contextChars: raw.contextChars,
    toolCalls: calls.length,
    calls,
    commands: calls.map((c) => c.command),
    diagnosticUpstream: raw.lastAssistantText.includes(UPSTREAM_MARKER),
    diagnosticDownstream: raw.lastAssistantText.includes(DOWNSTREAM_MARKER),
  };
}

/** First sorted `*.jsonl` in a directory; the path itself for a file; null if neither. */
function transcriptIn(target: string): string | null {
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return null;
  }
  if (stats.isFile()) return target;
  if (!stats.isDirectory()) return null;
  const files = readdirSync(target)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  return files.length > 0 ? join(target, files[0]) : null;
}

/** Directory that names the session, whichever form the target took. */
function labelFor(target: string): string {
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return basename(target);
  }
  return basename(stats.isDirectory() ? target : dirname(target));
}

const GLOB_CHARS = /[*?[{]/;

/** Translate one path segment of a glob into a matcher. */
function segmentRegExp(segment: string): RegExp {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "[" ) {
      const end = segment.indexOf("]", i + 1);
      if (end === -1) out += "\\[";
      else {
        out += `[${segment.slice(i + 1, end).replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else out += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Expand a target into existing paths. The shell usually does this, but a quoted
 * pattern must still work — the benchmark has to be reproducible from the exact
 * command line in the docs, whatever the reader's shell does with `*`.
 */
export function expandTarget(target: string): string[] {
  if (!GLOB_CHARS.test(target)) return existsSync(target) ? [target] : [];
  const absolute = target.startsWith("/");
  let frontier = [absolute ? "/" : "."];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (!GLOB_CHARS.test(segment)) {
      frontier = frontier
        .map((base) => join(base, segment))
        .filter((path) => existsSync(path));
      continue;
    }
    const matcher = segmentRegExp(segment);
    const hidden = segment.startsWith(".");
    const next: string[] = [];
    for (const base of frontier) {
      let entries: string[];
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      for (const name of entries) {
        // Shell globs skip dotfiles unless the pattern asks for them; mirror that
        // so discovery does not silently widen.
        if (name.startsWith(".") && !hidden) continue;
        if (matcher.test(name)) next.push(join(base, name));
      }
    }
    frontier = next;
  }
  return frontier.sort();
}

/** Expand every target, preserving argument order and dropping duplicates. */
export function resolveTargets(
  targets: string[],
): { paths: string[]; missing: string[] } {
  const paths: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const expanded = expandTarget(target);
    if (expanded.length === 0) {
      missing.push(target);
      continue;
    }
    for (const path of expanded) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return { paths, missing };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface Summary {
  arm: Arm;
  sessions: number;
  metrics: Record<string, { median: number; min: number; max: number }>;
  /** Sessions whose last assistant text carried at least one diagnostic marker. */
  diagnosticReach: number;
}

const SUMMARY_METRICS: Array<[string, (s: SessionMeasurement) => number]> = [
  ["execs", (s) => s.executions],
  ["wall_s", (s) => s.wallSeconds],
  ["blocked_s", (s) => s.blockedSeconds],
  ["idle_s", (s) => s.idleSeconds],
  ["sleep_s", (s) => s.agentSleepSeconds],
  ["ctx_chars", (s) => s.contextChars],
];

/** Median and range per arm — only where more than one session exists. */
export function summarize(sessions: SessionMeasurement[]): Summary[] {
  const arms: Arm[] = ["vanilla", "bgrun"];
  const summaries: Summary[] = [];
  for (const arm of arms) {
    const group = sessions.filter((s) => s.arm === arm);
    if (group.length < 2) continue;
    const metrics: Summary["metrics"] = {};
    for (const [key, pick] of SUMMARY_METRICS) {
      const values = group.map(pick);
      metrics[key] = {
        median: median(values),
        min: Math.min(...values),
        max: Math.max(...values),
      };
    }
    summaries.push({
      arm,
      sessions: group.length,
      metrics,
      diagnosticReach: group.filter((s) => s.diagnosticUpstream || s.diagnosticDownstream)
        .length,
    });
  }
  return summaries;
}

function seconds(value: number): string {
  return value.toFixed(1);
}

function chars(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function diagnosticLabel(session: SessionMeasurement): string {
  const marks: string[] = [];
  if (session.diagnosticUpstream) marks.push("up");
  if (session.diagnosticDownstream) marks.push("down");
  return marks.length > 0 ? marks.join("+") : "none";
}

const TABLE_COLUMNS: Array<[string, (s: SessionMeasurement) => string, number]> = [
  ["label", (s) => s.label, 22],
  ["arm", (s) => s.arm, 7],
  ["execs", (s) => String(s.executions), 5],
  ["fg", (s) => String(s.foregroundExecutions), 3],
  ["handoff", (s) => String(s.handoffs), 7],
  ["wall_s", (s) => seconds(s.wallSeconds), 7],
  ["blocked_s", (s) => seconds(s.blockedSeconds), 9],
  ["idle_s", (s) => seconds(s.idleSeconds), 7],
  ["sleep_s", (s) => seconds(s.agentSleepSeconds), 7],
  ["ctx_chars", (s) => chars(s.contextChars), 9],
  ["diag", (s) => diagnosticLabel(s), 8],
  ["calls", (s) => String(s.toolCalls), 5],
];

function pad(value: string, width: number): string {
  return value.length >= width ? value + " " : value.padEnd(width);
}

/** Human-readable report: session rows, the per-call ledger, then arm summaries. */
export function formatReport(
  sessions: SessionMeasurement[],
  summaries: Summary[],
  missing: string[],
): string {
  const lines: string[] = [];
  lines.push(
    TABLE_COLUMNS.map(([header, , width]) => pad(header, width)).join("").trimEnd(),
  );
  for (const session of sessions) {
    lines.push(
      TABLE_COLUMNS.map(([, render, width]) => pad(render(session), width))
        .join("")
        .trimEnd(),
    );
  }

  for (const session of sessions) {
    lines.push("");
    lines.push(`${session.label}  ${session.transcript}`);
    if (session.calls.length === 0) {
      lines.push("  (no tool calls)");
      continue;
    }
    lines.push(
      `  ${pad("#", 3)}${pad("tool", 10)}${pad("wait_s", 8)}${pad("result", 8)}${pad(
        "cum_ctx",
        10,
      )}command`,
    );
    session.calls.forEach((call, index) => {
      const command = call.command.replace(/\s+/g, " ").trim();
      lines.push(
        `  ${pad(String(index + 1), 3)}${pad(call.tool, 10)}${pad(
          seconds(call.waitSeconds),
          8,
        )}${pad(String(call.resultChars), 8)}${pad(
          chars(call.cumulativeContextChars),
          10,
        )}${command}${call.batched ? " [batched]" : ""}`,
      );
    });
  }

  lines.push("");
  lines.push("summary (median [min–max]; arms with a single session have no median)");
  for (const arm of ["vanilla", "bgrun"] as Arm[]) {
    const count = sessions.filter((s) => s.arm === arm).length;
    if (count === 0) continue;
    const summary = summaries.find((s) => s.arm === arm);
    if (!summary) {
      lines.push(`  ${arm} (1 session — median/range need ≥2)`);
      continue;
    }
    lines.push(`  ${summary.arm} (${summary.sessions} sessions)`);
    for (const [key] of SUMMARY_METRICS) {
      const m = summary.metrics[key];
      const value =
        key === "ctx_chars"
          ? `${chars(m.median)} [${chars(m.min)}–${chars(m.max)}]`
          : `${seconds(m.median)} [${seconds(m.min)}–${seconds(m.max)}]`;
      lines.push(`    ${pad(key, 11)}${value}`);
    }
    lines.push(
      `    ${pad("diag_reach", 11)}${summary.diagnosticReach}/${summary.sessions}`,
    );
  }

  if (missing.length > 0) {
    lines.push("");
    lines.push(`no match: ${missing.join(", ")}`);
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const CSV_COLUMNS = [
  "row",
  "label",
  "arm",
  "sessions",
  "execs",
  "foreground_execs",
  "handoffs",
  "wall_s",
  "blocked_s",
  "idle_s",
  "sleep_s",
  "ctx_chars",
  "tool_calls",
  "diag",
  "commands",
  "calls",
] as const;

/** Machine-readable table. Summary rows carry `median [min–max]` per metric cell. */
export function toCsv(
  sessions: SessionMeasurement[],
  summaries: Summary[],
): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const session of sessions) {
    lines.push(
      [
        "session",
        session.label,
        session.arm,
        "",
        String(session.executions),
        String(session.foregroundExecutions),
        String(session.handoffs),
        seconds(session.wallSeconds),
        seconds(session.blockedSeconds),
        seconds(session.idleSeconds),
        seconds(session.agentSleepSeconds),
        String(Math.round(session.contextChars)),
        String(session.toolCalls),
        diagnosticLabel(session),
        session.commands.join(" ; "),
        session.calls
          .map((c) => `${c.tool}@${seconds(c.waitSeconds)}s/${c.resultChars}`)
          .join(" ; "),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  for (const summary of summaries) {
    const range = (key: string): string => {
      const m = summary.metrics[key];
      const format = key === "ctx_chars" ? chars : seconds;
      return `${format(m.median)} [${format(m.min)}-${format(m.max)}]`;
    };
    lines.push(
      [
        "summary",
        `median [min-max] ${summary.arm} (n=${summary.sessions})`,
        summary.arm,
        String(summary.sessions),
        range("execs"),
        "",
        "",
        range("wall_s"),
        range("blocked_s"),
        range("idle_s"),
        range("sleep_s"),
        range("ctx_chars"),
        "",
        `${summary.diagnosticReach}/${summary.sessions}`,
        "",
        "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const targets: string[] = [];
  let csv = false;
  for (const arg of argv) {
    if (arg === "--csv") csv = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: bun scripts/measure-sessions.ts <dir-or-glob...> [--csv]");
      return 0;
    } else if (arg.startsWith("--")) {
      console.error(`unknown flag: ${arg}`);
      return 2;
    } else targets.push(arg);
  }
  if (targets.length === 0) {
    console.error("usage: bun scripts/measure-sessions.ts <dir-or-glob...> [--csv]");
    return 2;
  }

  const { paths, missing } = resolveTargets(targets);
  const sessions: SessionMeasurement[] = [];
  for (const path of paths) {
    const session = measureSession(labelFor(path), path);
    if (session.calls.length === 0 && !existsSync(session.transcript)) {
      // A directory with no transcript is not a session; say so rather than
      // reporting a fake zero row.
      console.error(`no transcript in ${path}`);
      continue;
    }
    sessions.push(session);
  }
  const summaries = summarize(sessions);
  if (csv) console.log(toCsv(sessions, summaries));
  else console.log(formatReport(sessions, summaries, missing));
  return 0;
}

// Guarded so tests can import the measurement functions without running the CLI.
if ((import.meta as { main?: boolean }).main) {
  process.exitCode = main(process.argv.slice(2));
}
