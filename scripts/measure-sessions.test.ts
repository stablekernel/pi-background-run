#!/usr/bin/env bun
/**
 * Tests for scripts/measure-sessions.ts.
 *
 * The transcripts here are SYNTHETIC and written to a temp dir, not checked in:
 * what needs proving is the metric contract (how a wait becomes blockedSeconds,
 * what counts as an execution, how an arm is inferred), and a fixture that pins
 * that is far smaller than a real session — and cannot silently rot when the
 * agent's wording changes. The real-session numbers are re-derived by running the
 * CLI against captured transcripts, which is the tool's whole point.
 *
 * node:test rather than bun:test, matching extension/index.test.ts: these run
 * under both runners with @types/node alone.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import {
  DOWNSTREAM_MARKER,
  UPSTREAM_MARKER,
  expandTarget,
  formatReport,
  measureSession,
  resolveTargets,
  summarize,
  toCsv,
} from "./measure-sessions.ts";

const root = mkdtempSync(join(tmpdir(), "measure-sessions-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

type Entry = Record<string, unknown>;

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

function assistant(second: number, parts: Entry[]): Entry {
  return {
    type: "message",
    timestamp: at(second),
    message: { role: "assistant", content: parts },
  };
}

function toolCall(id: string, name: string, command: string): Entry {
  return { type: "toolCall", id, name, arguments: { command } };
}

function toolResult(second: number, id: string, text: string): Entry {
  return {
    type: "message",
    timestamp: at(second),
    message: {
      role: "toolResult",
      toolCallId: id,
      content: [{ type: "text", text }],
    },
  };
}

/** Write a session directory holding one transcript; return the directory. */
function session(name: string, entries: Entry[], junkLines: string[] = []): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const lines = [...entries.map((entry) => JSON.stringify(entry)), ...junkLines];
  writeFileSync(join(dir, `${name}.jsonl`), `${lines.join("\n")}\n`);
  return dir;
}

test("blocking foreground run: the suite wait is blocked, the rest is idle", () => {
  const dir = session("blocking", [
    assistant(0, [toolCall("c1", "bash", "bun test extension/index.test.ts")]),
    toolResult(20, "c1", "229 pass"),
    assistant(30, [{ type: "text", text: "all green" }]),
  ]);

  const measured = measureSession("blocking", dir);
  assert.equal(measured.arm, "vanilla");
  assert.equal(measured.wallSeconds, 30);
  assert.equal(measured.executions, 1);
  assert.equal(measured.foregroundExecutions, 1);
  assert.equal(measured.handoffs, 0);
  assert.equal(measured.blockedSeconds, 20);
  assert.equal(measured.idleSeconds, 10);
  assert.equal(measured.toolCalls, 1);
  assert.equal(measured.calls[0].waitSeconds, 20);
  assert.equal(measured.calls[0].resultChars, 8);
});

test("several calls: every call is measured, only suite runs count as executions", () => {
  const dir = session("several", [
    assistant(0, [toolCall("c1", "bash", "bun test a")]),
    toolResult(5, "c1", "a"),
    assistant(6, [toolCall("c2", "bash", "bun test b")]),
    toolResult(12, "c2", "bb"),
    assistant(13, [toolCall("c3", "bash", "ls")]),
    toolResult(14, "c3", "ccc"),
  ]);

  const measured = measureSession("several", dir);
  assert.equal(measured.toolCalls, 3);
  assert.equal(measured.executions, 2);
  assert.equal(measured.blockedSeconds, 11);
  assert.deepEqual(measured.commands, ["bun test a", "bun test b", "ls"]);
  assert.deepEqual(
    measured.calls.map((call) => call.waitSeconds),
    [5, 6, 1],
  );
  assert.deepEqual(
    measured.calls.map((call) => call.resultChars),
    [1, 2, 3],
  );
  // cum_ctx is a running total, so it must strictly grow.
  assert.ok(
    measured.calls[2].cumulativeContextChars >
      measured.calls[0].cumulativeContextChars,
  );
});

test("no suite execution: mentioning the fixture is not executing it", () => {
  const dir = session("no-exec", [
    assistant(0, [toolCall("c1", "bash", "cat long-job.sh")]),
    toolResult(1, "c1", "#!/bin/sh"),
  ]);

  const measured = measureSession("no-exec", dir);
  assert.equal(measured.executions, 0);
  assert.equal(measured.foregroundExecutions, 0);
  assert.equal(measured.blockedSeconds, 0);
  assert.equal(measured.toolCalls, 1);
  // The session still reports: zero executions is a measurement, not a skip.
  assert.equal(measured.wallSeconds, 1);
});

test("no suite execution: a session with no tool calls reports zeros", () => {
  const dir = session("silent", [assistant(0, [{ type: "text", text: "hello" }])]);
  const measured = measureSession("silent", dir);
  assert.equal(measured.toolCalls, 0);
  assert.equal(measured.executions, 0);
  assert.equal(measured.wallSeconds, 0);
});

test("bgrun detection: a handoff is an execution, not a block", () => {
  const dir = session("bg", [
    assistant(0, [toolCall("c1", "bgrun", "bun test extension/index.test.ts")]),
    toolResult(0, "c1", "started: job-1"),
    assistant(10, [toolCall("c2", "bgstatus", "job-1")]),
    toolResult(10, "c2", "running"),
  ]);

  const measured = measureSession("bg", dir);
  assert.equal(measured.arm, "bgrun");
  assert.equal(measured.handoffs, 1);
  assert.equal(measured.foregroundExecutions, 0);
  assert.equal(measured.executions, 1);
  // The handoff returned instantly, so nothing was blocked on suite output.
  assert.equal(measured.blockedSeconds, 0);
  assert.equal(measured.idleSeconds, measured.wallSeconds);
});

test("diagnostic reach reads the LAST assistant text, not tool results", () => {
  const dir = session("fixture-red", [
    assistant(0, [
      toolCall("c1", "bash", "bun test extension/index.test.ts"),
      { type: "text", text: `saw ${UPSTREAM_MARKER} earlier` },
    ]),
    toolResult(5, "c1", `log body mentions ${DOWNSTREAM_MARKER}`),
    assistant(6, [{ type: "text", text: "done" }]),
  ]);

  const measured = measureSession("fixture-red", dir);
  assert.equal(measured.diagnosticUpstream, false);
  assert.equal(measured.diagnosticDownstream, false);

  const reached = measureSession(
    "fixture-red-2",
    session("fixture-red-2", [
      assistant(0, [toolCall("c1", "bash", "bun test")]),
      toolResult(5, "c1", "log"),
      assistant(6, [{ type: "text", text: UPSTREAM_MARKER }]),
    ]),
  );
  assert.equal(reached.diagnosticUpstream, true);
  assert.equal(reached.diagnosticDownstream, false);
});

test("tolerance: unknown entries, junk lines and unmatched results are skipped", () => {
  const dir = session(
    "ragged",
    [
      assistant(0, [toolCall("c1", "bash", "bun test")]),
      { type: "session_info", timestamp: at(1) },
      { type: "model_change", timestamp: at(2) },
      {
        type: "message",
        timestamp: at(3),
        message: { role: "toolResult", content: [] },
      },
      toolResult(4, "c1", "ok"),
    ],
    ["{ this is not json", ""],
  );

  const measured = measureSession("ragged", dir);
  assert.equal(measured.executions, 1);
  assert.equal(measured.toolCalls, 2);
  // The unmatched (toolCallId-less) result pairs by arrival order, which is c1.
  assert.equal(measured.calls[0].tool, "bash");
  assert.equal(measured.calls[1].tool, "?");
});

const paired = (dirA: string, dirB: string) => {
  const sessions = [measureSession("a", dirA), measureSession("b", dirB)];
  return { sessions, summaries: summarize(sessions) };
};

const runDir = (name: string, waitSeconds: number): string =>
  session(name, [
    assistant(0, [toolCall("c1", "bash", "bun test")]),
    toolResult(waitSeconds, "c1", "x"),
  ]);

test("a summary needs two sessions of one arm and keeps the spread", () => {
  const { sessions, summaries } = paired(runDir("agg-a", 4), runDir("agg-b", 10));

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].arm, "vanilla");
  assert.deepEqual(summaries[0].metrics.blocked_s, { median: 7, min: 4, max: 10 });

  const report = formatReport(sessions, summaries, []);
  assert.ok(report.includes("blocked_s"));
  assert.ok(report.includes("7.0 [4.0–10.0]"));
  // A single-session arm gets no median rather than a degenerate one.
  assert.ok(formatReport(sessions, summarize([sessions[0]]), []).includes("1 session"));
});

test("--csv emits a row per session plus a summary row and quotes commas", () => {
  const { sessions, summaries } = paired(runDir("csv-a", 4), runDir("csv-b", 10));
  const rows = toCsv(sessions, summaries).split("\n");

  assert.ok(rows[0].startsWith("row,label,arm,sessions,execs"));
  assert.equal(rows.filter((row) => row.startsWith("session,")).length, 2);
  assert.equal(rows.filter((row) => row.startsWith("summary,")).length, 1);
  // Median and range both survive the CSV form.
  assert.ok(rows[rows.length - 1].includes("7.0 [4.0-10.0]"));

  const commaDir = session("csv-comma", [
    assistant(0, [toolCall("c1", "bash", "bun test a,b")]),
    toolResult(4, "c1", "x"),
  ]);
  const commaRow = toCsv([measureSession("csv-comma", commaDir)], []).split("\n")[1];
  assert.ok(commaRow.includes('"bun test a,b"'));
});

test("target resolution expands globs and reports misses", () => {
  const first = session("glob-a", [assistant(0, [{ type: "text", text: "x" }])]);
  session("glob-b", [assistant(0, [{ type: "text", text: "y" }])]);

  assert.deepEqual(expandTarget(join(root, "glob-*")), [first, join(root, "glob-b")]);

  const { paths, missing } = resolveTargets([join(root, "glob-*"), "no-such-dir"]);
  assert.equal(paths.length, 2);
  assert.deepEqual(missing, ["no-such-dir"]);
});
