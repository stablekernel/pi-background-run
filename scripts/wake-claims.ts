#!/usr/bin/env bun
/**
 * wake-claims.ts — does a session claim a completion wake it has not received?
 *
 * WHY THIS EXISTS
 * ---------------
 * The first benchmark cell (`red-tail-short`) showed every bgrun session polling a job it had
 * just handed off, and every one of them asserting the wake in writing ("**Wake received.**")
 * while the job was still running. The assertion is what licenses the polling: the tool's own
 * description forbids polling, so a session that wants to read the log has to claim the premise
 * it is missing. Measured in the cell's record:
 *
 *   docs/benchmark/runs/red-tail-short/CELL.md, and predictions.md `H12 <fabricated-wake>`.
 *
 * The phrase alone is not the signal — speak of a wake *after* it arrives is correct behaviour
 * ("the wake just confirmed what I found"). The signal is **timing**: a session that says it has
 * been woken while its job has not exited has invented the premise, because until the job exits
 * there is nothing to be woken about. The job's own records carry the ground truth: the
 * extension writes a `bgrun-job` entry at handoff (`started`) and again at exit (`state: done`,
 * `exitedAt`).
 *
 * WHAT IT REPORTS, per session
 * ----------------------------
 *   calls_before_exit   tool calls made while the job was still running — a poll, by definition
 *   calls_after_exit    calls made once the job had exited — a read, which is the intent
 *   claims_before_exit  messages asserting a wake the session could not have received
 *   first_claim_at      that message's offset from the job's start
 *
 * The number the fix is graded on is `claims_before_exit`: it should be 0 in every session, and
 * `calls_before_exit` should collapse to 0 or 1 with it.
 *
 * USAGE
 * -----
 *   bun scripts/wake-claims.ts <dir-or-glob...> [--csv]
 *
 * A target is a session directory (its first `*.jsonl`, sorted), a transcript file, or a glob.
 * Sessions with no bgrun job at all (the vanilla arm) report `-`: they have no wake to claim.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Text that asserts a wake has already happened (or is here), rather than describing one. */
const CLAIM_PATTERNS = [
  /\bwake\s+received\b/i,
  /\bi(?:'ve| have)?\s*been\s+woken\b/i,
  /\bwake\b[^.\n]{0,60}\b(?:arrived|just arrived|confirmed|just confirmed|came)\b/i,
  /\b(?:the\s+)?wake\s+(?:message|notice|notification)\s+(?:arrived|landed|came)\b/i,
];

interface JobSpan {
  started: number | null;
  exitedAt: number | null;
}

interface SessionScan {
  label: string;
  transcript: string;
  job: JobSpan;
  callsBeforeExit: number;
  callsAfterExit: number;
  claimsBeforeExit: number;
  claimsAfterExit: number;
  firstClaimAtSeconds: number | null;
  firstClaimText: string;
}

function transcriptIn(target: string): string | null {
  if (!existsSync(target)) return null;
  if (statSync(target).isFile()) return target.endsWith(".jsonl") ? target : null;
  const jsonl = readdirSync(target)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  return jsonl.length > 0 ? join(target, jsonl[0]) : null;
}

function millisOf(entry: Record<string, unknown>): number | null {
  const raw = entry.timestamp;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function messageText(entry: Record<string, unknown>): { text: string; thinking: string } {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  let text = "";
  let thinking = "";
  if (!Array.isArray(content)) return { text, thinking };
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as { text?: unknown; thinking?: unknown; type?: unknown };
    if (typeof record.text === "string") text += `${record.text}\n`;
    if (typeof record.thinking === "string") thinking += `${record.thinking}\n`;
  }
  return { text, thinking };
}

function hasToolCall(entry: Record<string, unknown>): boolean {
  const message = entry.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return false;
  return message.content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "toolCall",
  );
}

function scan(label: string, transcript: string): SessionScan {
  const scan: SessionScan = {
    label,
    transcript,
    job: { started: null, exitedAt: null },
    callsBeforeExit: 0,
    callsAfterExit: 0,
    claimsBeforeExit: 0,
    claimsAfterExit: 0,
    firstClaimAtSeconds: null,
    firstClaimText: "",
  };

  let text: string;
  try {
    text = readFileSync(transcript, "utf8");
  } catch {
    return scan;
  }

  // Messages are collected first and judged at the end, once the job's exit is known. A
  // single pass compares each message against a record it has not reached yet — which is
  // how the first version of this file reported "0 claims before exit" for a session whose
  // claim is quoted in CELL.md.
  const observations: { at: number; hasCall: boolean; claimLine: string | null }[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // The extension's own job records: `started` at handoff, `exitedAt` at exit.
    if (entry.type === "custom" && entry.customType === "bgrun-job") {
      const data = entry.data as { started?: unknown; exitedAt?: unknown; state?: unknown } | undefined;
      if (data && typeof data.started === "number" && scan.job.started === null) {
        scan.job.started = data.started;
      }
      if (data && typeof data.exitedAt === "number") {
        scan.job.exitedAt = data.exitedAt;
      }
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    const at = millisOf(entry);
    if (at === null) continue;

    const { text: said, thinking } = messageText(entry);
    // Only the assistant's own words count, and only the first line that claims it.
    const claimLine =
      `${said}\n${thinking}`
        .split("\n")
        .find((candidate) => CLAIM_PATTERNS.some((pattern) => pattern.test(candidate))) ??
      null;
    observations.push({ at, hasCall: hasToolCall(entry), claimLine });
  }

  // "Before exit" means before the job's exit record exists. A message only counts once
  // that record is known: without one (a job still running, or a record the writer lost)
  // nothing is before-or-after, and the session is reported as unknown rather than
  // flattered.
  for (const seen of observations) {
    const beforeExit = scan.job.exitedAt === null ? null : seen.at < scan.job.exitedAt;
    if (seen.hasCall) {
      if (beforeExit === true) scan.callsBeforeExit += 1;
      else if (beforeExit === false) scan.callsAfterExit += 1;
    }
    if (seen.claimLine === null) continue;
    if (beforeExit === true) {
      scan.claimsBeforeExit += 1;
      if (scan.firstClaimAtSeconds === null && scan.job.started !== null) {
        scan.firstClaimAtSeconds = (seen.at - scan.job.started) / 1000;
        scan.firstClaimText = seen.claimLine.trim().slice(0, 90);
      }
    } else if (beforeExit === false) {
      scan.claimsAfterExit += 1;
    }
  }

  return scan;
}

function expandTargets(patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      if (transcriptIn(pattern) !== null) out.push(pattern);
      else if (!existsSync(pattern)) console.error(`skipping (not found): ${pattern}`);
      else console.error(`skipping (no *.jsonl): ${pattern}`);
      continue;
    }
    // Minimal glob: a directory prefix plus `*`, which is what shells hand over quoted.
    const star = pattern.indexOf("*");
    const dir = pattern.slice(0, star).replace(/\/$/, "") || ".";
    const rest = pattern.slice(star);
    if (!existsSync(dir)) {
      console.error(`skipping (not found): ${pattern}`);
      continue;
    }
    for (const name of readdirSync(dir).sort()) {
      if (!existsSync(join(dir, name))) continue;
      // `*` matches one segment here, which is all these cells need.
      if (rest === "*" || rest === "*/") {
        const nested = transcriptIn(join(dir, name));
        if (nested !== null) out.push(join(dir, name));
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
const asCsv = args.includes("--csv");
const targets = expandTargets(args.filter((arg) => arg !== "--csv"));

if (targets.length === 0) {
  console.error("usage: bun scripts/wake-claims.ts <dir-or-glob...> [--csv]");
  process.exit(2);
}

const scans = targets.map((target) => {
  const transcript = transcriptIn(target);
  if (transcript === null) {
    console.error(`skipping (no *.jsonl): ${target}`);
    return null;
  }
  return scan(basename(target), transcript);
}).filter((entry): entry is SessionScan => entry !== null);

if (asCsv) {
  console.log("session,calls_before_exit,calls_after_exit,claims_before_exit,claims_after_exit,first_claim_at_s");
  for (const s of scans) {
    const noJob = s.job.exitedAt === null && s.job.started === null;
    console.log(
      [
        s.label,
        noJob ? "-" : String(s.callsBeforeExit),
        noJob ? "-" : String(s.callsAfterExit),
        noJob ? "-" : String(s.claimsBeforeExit),
        noJob ? "-" : String(s.claimsAfterExit),
        s.firstClaimAtSeconds === null ? "" : s.firstClaimAtSeconds.toFixed(1),
      ].join(","),
    );
  }
  process.exit(0);
}

const pad = (value: string, width: number) => value.padEnd(width);
console.log(
  `${pad("session", 14)}${pad("job_s", 8)}${pad("calls<exit", 11)}${pad("calls>exit", 11)}${pad("claims<exit", 12)}${pad("claims>exit", 12)}first claim`,
);
for (const s of scans) {
  const noJob = s.job.exitedAt === null && s.job.started === null;
  const jobSeconds =
    s.job.started !== null && s.job.exitedAt !== null
      ? ((s.job.exitedAt - s.job.started) / 1000).toFixed(1)
      : "-";
  const firstClaim =
    s.firstClaimAtSeconds === null
      ? ""
      : `+${s.firstClaimAtSeconds.toFixed(1)}s  ${s.firstClaimText}`;
  console.log(
    `${pad(s.label, 14)}${pad(jobSeconds, 8)}${pad(noJob ? "-" : String(s.callsBeforeExit), 11)}${pad(
      noJob ? "-" : String(s.callsAfterExit),
      11,
    )}${pad(noJob ? "-" : String(s.claimsBeforeExit), 12)}${pad(
      noJob ? "-" : String(s.claimsAfterExit),
      12,
    )}${firstClaim}`,
  );
}

const withJob = scans.filter((s) => s.job.started !== null);
const offending = withJob.filter((s) => s.claimsBeforeExit > 0);
console.log();
if (withJob.length === 0) {
  console.log("no bgrun job in any session — nothing to claim (the vanilla arm).");
} else if (offending.length === 0) {
  console.log(
    `claims before exit: 0 of ${withJob.length} session(s) — no session asserted a wake it had not received.`,
  );
} else {
  const total = offending.reduce((sum, s) => sum + s.claimsBeforeExit, 0);
  console.log(
    `claims before exit: ${total} across ${offending.length} of ${withJob.length} session(s) — ` +
      `${offending.map((s) => s.label).join(", ")}. Each one is a premise invented to license a poll.`,
  );
}
