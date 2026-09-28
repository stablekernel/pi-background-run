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
 *
 * BACKWARD-EQUIVALENCE CONTRACT (mirrors the header of make-dummy-suite.ts)
 * ------------------------------------------------------------------------
 * The bytes the generator emits are a frozen contract for every recorded fixture.
 *   1. Any change MUST leave each recorded fixture's bytes unchanged for its
 *      recorded knobs. A silent byte change invalidates a cell's recorded fixture
 *      hash and everything measured against it — the afb2bd1 blank-line drift did
 *      exactly this and went unnoticed.
 *   2. Adding a fixture means adding a row to RECORDED_FIXTURES below, with its
 *      exact knobs, its recorded absolute path and its expected hash.
 *   3. This test is what enforces the contract. An INTENTIONAL byte change
 *      requires regenerating the affected fixture at its recorded path and
 *      updating its record — never silencing or loosening the test.
 *
 * The recorded hash is the fixture's files sorted by path, their contents
 * concatenated, sha1, first 16 hex — computed at the fixture's RECORDED ABSOLUTE
 * PATH. The generated files embed their own out-dir path in the failure's stack
 * trace, so the hash means nothing without that path: the same knobs regenerated
 * at a scratch path hash differently. The table test therefore normalises the
 * scratch out-dir path back to the recorded one before hashing.
 *
 * A fixture hash pins ONE cell's workload, never the set: the recorded fixtures
 * were generated at different generator revisions (red-tail and equiv predate
 * afb2bd1; long-buried and trace-root were generated at it). The table below is
 * what keeps each one's bytes honest.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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

// ── Backward-equivalence contract: the recorded fixtures ────────────────────
// Each row is a fixture whose bytes are frozen (see the contract at the top of
// this file and the generator's header). `sha` is the value the generator MUST
// reproduce for `knobs`, hashed at `path`. `recordNote` is where a cell's record
// quotes a different value — either because the record is stale, or because the
// fixture was generated before the afb2bd1 blank-line drift and the record still
// carries the drifted bytes.
interface FixtureRecord {
  name: string;
  knobs: Record<string, string>;
  /** The absolute path the fixture was generated at; the hash depends on it. */
  path: string;
  /** Files sorted by path, contents concatenated, sha1, first 16 hex. */
  sha: string;
  recordNote?: string;
}

const RECORDED_FIXTURES: FixtureRecord[] = [
  {
    // Cell 1 (docs/benchmark/runs/red-tail-short/RUNSHEET.md) quotes this same
    // value. It is the fixture the afb2bd1 drift broke: before the fix the same
    // knobs produced dedf28f736923ad8 (one blank line too many after the imports).
    name: "red-tail",
    path: "/private/tmp/red-tail-fixture",
    knobs: {
      DUMMY_FILES: "2",
      DUMMY_TESTS_PER_FILE: "4",
      DUMMY_SLEEP_MS: "1",
      DUMMY_FAIL_FILE: "2",
      DUMMY_FAIL_STEP: "4",
      DUMMY_LINES_PER_TEST: "2",
      DUMMY_ANNOUNCE_FAILURE: "0",
      DUMMY_CAUSE_MODULE: "0",
    },
    sha: "0bfe00ed1d9866b9",
  },
  {
    // Cell 3 (docs/benchmark/runs/trace-root/RUNSHEET.md) quotes this same value.
    // It is the cause-module shape; the fix must leave it byte-identical.
    name: "trace-root",
    path: "/private/tmp/trace-root-fixture",
    knobs: {
      DUMMY_FILES: "2",
      DUMMY_TESTS_PER_FILE: "4",
      DUMMY_SLEEP_MS: "1",
      DUMMY_FAIL_FILE: "2",
      DUMMY_FAIL_STEP: "4",
      DUMMY_LINES_PER_TEST: "2",
      DUMMY_ANNOUNCE_FAILURE: "0",
      DUMMY_CAUSE_MODULE: "1",
    },
    sha: "605aba38baf5c6ad",
  },
  {
    // This fixture is causeModule 0 and was generated at the DRIFTED generator, so
    // its hash necessarily moves once red-tail's inline shape is restored — no
    // single generator emits one blank line for red-tail and two for long-buried.
    // The cells measured against it stand: a one-line shift touches no reported
    // number. The row pins the bytes the fixed generator now produces.
    name: "long-buried",
    path: "/private/tmp/long-buried-fixture",
    knobs: {
      DUMMY_FILES: "10",
      DUMMY_TESTS_PER_FILE: "30",
      DUMMY_SLEEP_MS: "600",
      DUMMY_FAIL_FILE: "5",
      DUMMY_FAIL_STEP: "15",
      DUMMY_LINES_PER_TEST: "2",
      DUMMY_ANNOUNCE_FAILURE: "0",
      DUMMY_CAUSE_MODULE: "0",
      DUMMY_FAIL_FAST: "0",
    },
    sha: "a80876eac7089297",
    recordNote:
      "the fixture on disk at the time of these runs was generated at a generator revision that emitted an extra blank line, so the fixed generator yields a80876eac7089297 and this run's frame is quoted at part-05.test.ts:59 where a fresh fixture yields :58; no reported number depends on the difference",
  },
];

/**
 * The documented hash, computed the way the records state it: files sorted by
 * path, contents concatenated, sha1, first 16 hex. The scratch out-dir path is
 * normalised back to the recorded path first, because the generated files embed
 * their own out-dir path in the failure's stack trace.
 */
function hashFixture(outDir: string, recordedPath: string): string {
  const files = readdirSync(outDir)
    .map((name) => join(outDir, name))
    .sort();
  const hash = createHash("sha1");
  for (const file of files) {
    hash.update(readFileSync(file, "utf8").split(outDir).join(recordedPath));
  }
  return hash.digest("hex").slice(0, 16);
}

test("recorded fixtures: each regenerates to the bytes the contract freezes", () => {
  for (const fixture of RECORDED_FIXTURES) {
    const outDir = join(root, `recorded-${fixture.name}`);
    const result = spawnSync("bun", ["run", script], {
      encoding: "utf8",
      env: { ...process.env, DUMMY_OUT_DIR: outDir, ...fixture.knobs },
    });
    assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`);

    // Regenerating into a temp dir and normalising the embedded path must recover
    // the record's hash; if the generator's bytes moved, this is where it shows.
    assert.equal(
      hashFixture(outDir, fixture.path),
      fixture.sha,
      `${fixture.name}: regenerated bytes no longer match the frozen hash` +
        (fixture.recordNote ? ` (${fixture.recordNote})` : ""),
    );
  }
});
