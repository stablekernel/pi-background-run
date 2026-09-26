#!/usr/bin/env bun
/**
 * Tests for scripts/make-dummy-suite.ts.
 *
 * What needs proving is the fixture's SHAPE CONTRACT — the parts a battery reads
 * and no one can eyeball at a glance: which file the trace's deepest frame names,
 * that a trace line number is where the code actually sits, and that the planted
 * failure really fails. A generator that silently emitted the inline shape, or a
 * stale line number, would send a session looking somewhere else and quietly
 * invalidate a diagnosis cell — which is the whole job of the knob tested here.
 *
 * Generation writes to a temp dir and the knobs below hold the suite at six tiny
 * tests, so the file runs in well under a second and never touches the repo.
 *
 * node:test rather than bun:test, matching extension/index.test.ts: these run
 * under both runners with @types/node alone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "make-dummy-suite.ts",
);
const root = mkdtempSync(join(tmpdir(), "make-dummy-suite-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const failingPart = "part-02.test.ts";

interface Generation {
  status: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

function generate(name: string, env: Record<string, string> = {}): Generation {
  const outDir = join(root, name);
  const result = spawnSync("bun", ["run", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DUMMY_OUT_DIR: outDir,
      DUMMY_FILES: "2",
      DUMMY_TESTS_PER_FILE: "3",
      DUMMY_FAIL_FILE: "2",
      DUMMY_FAIL_STEP: "2",
      DUMMY_SLEEP_MS: "1",
      DUMMY_ANNOUNCE_FAILURE: "0",
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    outDir,
  };
}

/** The 1-based line holding `needle`, or 0 — the convention the script itself uses. */
function lineOf(text: string, needle: string): number {
  return text.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

test("cause module: the assertion sits one frame from the failing test, at real lines", () => {
  const { status, stderr, outDir } = generate("cause-on", {
    DUMMY_CAUSE_MODULE: "1",
  });
  assert.equal(status, 0, stderr);

  const harness = readFileSync(join(outDir, "harness.ts"), "utf8");
  const failing = readFileSync(join(outDir, failingPart), "utf8");

  // The module exists and only the failing test reaches for it; Bun discovers
  // tests by name, so harness.ts cannot be picked up as one either.
  assert.match(failing, /import \{ loadStep \} from "\.\/harness";/);
  assert.match(failing, /loadStep\(\);/);

  // The invariant a diagnosis cell reads: the planted block's frames name the
  // lines the code actually sits on, in both files. A drift here is invisible in
  // the fixture's output and would misdirect the session it is built to measure.
  const assertLine = lineOf(harness, "assert.deepEqual");
  const callLine = lineOf(failing, "loadStep();");
  assert.ok(assertLine > 0, "the assertion must exist in the module");
  assert.ok(callLine > 0, "the call site must exist in the failing test");
  assert.ok(
    harness.includes(
      `at loadStep (${join(outDir, "harness.ts")}:${assertLine}:9)`,
    ),
    "the block must name the assertion's real line",
  );
  assert.ok(
    harness.includes(
      `at load part 02 (${join(outDir, failingPart)}:${callLine}:25)`,
    ),
    "the block must name the call site's real line",
  );
  for (const text of [harness, failing]) {
    assert.doesNotMatch(text, /__(FAIL|CALL)_LINE__/);
  }
});

test("cause module: the run fails, and its trace names a file that is not the failing test", () => {
  const { outDir } = generate("cause-on-run", { DUMMY_CAUSE_MODULE: "1" });
  const run = spawnSync("bun", ["test", outDir], { encoding: "utf8" });
  assert.notEqual(run.status, 0, "the planted failure must fail the run");

  const trace = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  // These two lines ARE the cell: the deepest frame is the cause's own file, and
  // the frame under it is the call site — not runner plumbing, not the same file.
  assert.match(trace, /at loadStep \(.*harness\.ts:\d+:\d+\)/);
  assert.match(
    trace,
    new RegExp(`at load part 02 \\(.*${failingPart}:\\d+:\\d+\\)`),
  );
});

test("cause module: off by default, the assertion stays inline", () => {
  const { status, stderr, outDir } = generate("cause-off");
  assert.equal(status, 0, stderr);
  assert.equal(
    existsSync(join(outDir, "harness.ts")),
    false,
    "the module is opt-in — existing fixtures and their recorded shapes depend on it",
  );
  const failing = readFileSync(join(outDir, failingPart), "utf8");
  assert.match(failing, /assert\.deepEqual\(/);
  assert.doesNotMatch(failing, /loadStep/);
});

test("cause module: a value other than 0 or 1 is rejected, not ignored", () => {
  const { status, stderr } = generate("cause-bad", { DUMMY_CAUSE_MODULE: "2" });
  assert.equal(status, 2);
  assert.match(stderr, /DUMMY_CAUSE_MODULE must be 0 or 1/);
});
