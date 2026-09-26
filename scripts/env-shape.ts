#!/usr/bin/env bun
// What a session can actually see.
//
// Three questions, all of which decide whether a cell's numbers mean anything:
//
//   1. SHAPE. The same fixture runs in two environments - a pi session's own
//      (AGENT/CLAUDECODE set) and a plain shell. Bun's reporter suppresses per-test
//      lines in the first and prints them in the second, so the *shape* of a
//      failure's neighbourhood differs by environment, not by terminal. Any count
//      quoted from a run without this recorded is untraceable.
//
//   2. WHICH STREAM. The failure block (assertion, frames, the marker pair) goes to
//      stderr; the per-test lines and the summary go to stdout. A session that
//      redirects stdout only - the obvious `bun test … > log` - therefore captures a
//      log with the failure block missing, and in an agent environment it also loses
//      the per-test lines that would have named the failing test.
//
//   3. EVIDENCE PATH. A batched job's output reaches a session through exactly two
//      doors: the digest the wake carries, and the log's last line. This prints what
//      is behind each one for a failing run.
//
// Output order matters: capture is `> log 2>&1` (interleaved as the process writes),
// because concatenating the two streams afterwards moves the failure block to the end
// and reports a failure position that no session would ever see.
//
// It asserts the environment actually took effect. An earlier version of this check ran
// under `bgrun`, whose shell does not inherit AGENT/CLAUDECODE - both labelled
// environments were the same environment and the result looked like a finding. The
// guard below is that mistake, encoded.
//
// Usage: bun scripts/env-shape.ts [--sleep <ms>] [--runs <n>] [--full]

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : (args[i + 1] ?? dflt);
};
const full = args.includes("--full");
const sleepMs = flag("--sleep", full ? "600" : "1");
const runs = Number(flag("--runs", "1"));

const dir = mkdtempSync(join(tmpdir(), "env-shape-"));
const fixture = join(dir, "fixture");

const gen = spawnSync("bun", ["scripts/make-dummy-suite.ts"], {
  env: { ...process.env, DUMMY_OUT_DIR: fixture, DUMMY_SLEEP_MS: sleepMs },
  encoding: "utf8",
});
if (gen.status !== 0) throw new Error(`fixture generation failed:\n${gen.stderr}`);

const files = readdirSync(fixture).sort();
const hash = createHash("sha256")
  .update(files.map((f) => readFileSync(join(fixture, f))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)))
  .digest("hex")
  .slice(0, 16);

const ENVS: Record<string, Record<string, string>> = {
  agent: { AGENT: "1", CLAUDECODE: "1" },
  plain: { AGENT: "", CLAUDECODE: "", TERM: "xterm-256color" },
};

type Shape = {
  env: string;
  vars: string;
  total: number;
  perTest: number;
  failAt: number;
  frames: number;
  exit: number | null;
  wallMs: number;
  text: string;
};

const sh = (cmd: string, env: NodeJS.ProcessEnv) => spawnSync("sh", ["-c", cmd], { env, encoding: "utf8" });

function runOnce(label: string, vars: Record<string, string>): Shape {
  const log = join(dir, `${label}.log`);
  const env = { ...process.env, ...vars };
  const t0 = Date.now();
  const r = sh(`exec bun test '${fixture}' > '${log}' 2>&1`, env);
  const wall = Date.now() - t0;
  const text = readFileSync(log, "utf8");
  const lines = text.split("\n");
  return {
    env: label,
    vars: Object.keys(vars).map((k) => `${k}=${env[k] || "unset"}`).join(" "),
    total: lines.length - 1,
    perTest: lines.filter((l) => /^\s*(\(pass\)|\(fail\))/.test(l)).length,
    failAt: lines.findIndex((l) => l.includes("DIAGNOSTIC_MARKER_UPSTREAM")) + 1,
    frames: lines.filter((l) => /^\s+at /.test(l)).length,
    exit: r.status,
    wallMs: wall,
    text,
  };
}

console.log(`fixture ${fixture}\n  sha ${hash}  sleep ${sleepMs}ms  runs ${runs}\n`);

const results: Shape[] = [];
for (const [label, vars] of Object.entries(ENVS)) {
  for (let i = 0; i < runs; i++) {
    const s = runOnce(runs > 1 ? `${label}-${i + 1}` : label, vars);
    results.push({ ...s, env: label });
    const pct = s.total ? Math.round((100 * s.failAt) / s.total) : 0;
    console.log(
      `  ${s.env.padEnd(6)} total=${String(s.total).padStart(4)} per-test=${String(s.perTest).padStart(3)} ` +
        `fail@=${String(s.failAt).padStart(4)} (${pct}%) frames=${s.frames} exit=${s.exit} wall=${(s.wallMs / 1000).toFixed(1)}s`,
    );
    console.log(`         env as seen: ${s.vars}`);
  }
}

const agent = results.filter((r) => r.env === "agent");
const plain = results.filter((r) => r.env === "plain");
if (plain.length && agent.length && plain[0].total === agent[0].total && plain[0].perTest === agent[0].perTest) {
  console.error(
    `\n  INVALID: both labelled environments produced the same shape ` +
      `(${agent[0].total} lines, ${agent[0].perTest} per-test).\n` +
      `  The variables did not take effect - do not record these numbers as a comparison.`,
  );
  process.exit(1);
}
console.log(`\n  environment comparison is valid: shapes differ by ${plain[0].total - agent[0].total} lines\n`);

// --- which stream carries the diagnosis --------------------------------------
const out = join(dir, "split.out");
const err = join(dir, "split.err");
sh(`exec bun test '${fixture}' > '${out}' 2> '${err}'`, { ...process.env, ...ENVS.plain });
const outText = readFileSync(out, "utf8");
const errText = readFileSync(err, "utf8");
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;
console.log(`  redirecting stdout only (\`bun test … > log\`), plain environment:`);
console.log(`    stdout: ${count(outText, /^.*$/gm)} lines, ${count(outText, /^\s*\(fail\)/gm)} failing-test lines, ${count(outText, /^\s+at /gm)} frames, marker: ${outText.includes("DIAGNOSTIC_MARKER_UPSTREAM")}`);
console.log(`    stderr: ${count(errText, /^.*$/gm)} lines, ${count(errText, /^\s*\(fail\)/gm)} failing-test lines, ${count(errText, /^\s+at /gm)} frames, marker: ${errText.includes("DIAGNOSTIC_MARKER_UPSTREAM")}`);
const echoesPlant = outText.includes("the planted failure is");
console.log(`    the fixture echoes the planted failure's location to stdout: ${echoesPlant}  (a crutch a real project would not print)`);

// --- what reaches a session at wake ------------------------------------------
const widest = plain[0].total >= agent[0].total ? plain[0] : agent[0];
const digest = widest.text.split("\n").filter((l) => /[0-9]+ (pass|fail)$/.test(l)).slice(-5);
const last = widest.text.split("\n").filter(Boolean).slice(-1)[0];
const failing = widest.text.split("\n").filter((l) => /^\s*\(fail\)/.test(l)).slice(-1)[0] ?? "(none on stdout)";
console.log(`\n  at wake, a session sees:`);
console.log(`    digest (configured grep|tail): ${JSON.stringify(digest)}`);
console.log(`    log's last line:               ${(last ?? "").slice(0, 90)}`);
console.log(`    the failing test's name:       ${failing.trim().slice(0, 90)}`);
console.log(`    frames reachable without opening the log: 0`);
console.log(`\n  The condenser half of this check needs bgtail on a live job's log - not reachable from here.`);
rmSync(dir, { recursive: true, force: true });
