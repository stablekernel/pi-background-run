#!/usr/bin/env bun
/**
 * Tests for scripts/pty-shape.ts.
 *
 * WHAT IS BEING PINNED
 * --------------------
 * The probe answers one question — does bun's test reporter present a different
 * output SHAPE when stdout is a pseudo-terminal rather than a pipe — and the
 * benchmark's volume numbers all rest on the answer. A check for that must not
 * itself depend on the answer: it asserts the RELATIONSHIP, not a fixed shape.
 * So the assertions here are:
 *
 *   - the pty shape is never smaller than the piped shape;
 *   - every line that exists in one shape and not the other is a per-test line
 *     (compare both outputs with and without those lines, durations normalised);
 *   - the fixture's own output — stage lines, banners, summary, failure block —
 *     is present and identical across the two shapes.
 *
 * The scale is smoke: a 2 x 3 fixture with a 10 ms sleep, generated into a temp
 * dir outside the repo. The whole file runs in well under a second, so CI pays
 * nothing for the instrument.
 *
 * NO SILENT SKIP: pseudo-terminal acquisition is platform-portable — macOS/BSD
 * uses `script -q /dev/null <cmd…>`, util-linux (CI/Ubuntu) uses
 * `script -qec "<cmd>" /dev/null` — and the mechanism is proved, not assumed. If
 * neither works the probe throws and those tests FAIL with a message naming the
 * two forms; a skipped instrument check would be worse than none.
 *
 * node:test rather than bun:test, matching the other scripts/ tests: this runs
 * under both runners with @types/node alone.
 */
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import {
  SMOKE_KNOBS,
  detectPtyRunner,
  runProbe,
  type ProbeResult,
} from "./pty-shape.ts";

let probe: ProbeResult | undefined;
function probeResult(): ProbeResult {
  probe ??= runProbe();
  return probe;
}

after(() => {
  if (probe) rmSync(probe.fixtureDir, { recursive: true, force: true });
});

test("a portable pseudo-terminal mechanism is available", () => {
  const runner = detectPtyRunner();
  assert.ok(
    runner,
    "no pty mechanism worked: tried BSD `script -q /dev/null <cmd…>` and " +
      "util-linux `script -qec \"<cmd>\" /dev/null`. The probe cannot run and " +
      "must not pass silently — install a working script(1).",
  );
});

test("the pty shape has at least as many lines as the piped shape", () => {
  const { pipe, pty } = probeResult();
  assert.ok(
    pty.totalLines >= pipe.totalLines,
    `pty shape has ${pty.totalLines} lines, fewer than the piped shape's ` +
      `${pipe.totalLines} — the reporter cannot be losing lines to a terminal`,
  );
});

test("every line that differs between the shapes is a per-test line", () => {
  const { diff } = probeResult();
  assert.deepEqual(
    diff.nonPerTestDifferences,
    [],
    `the shapes differ in ${diff.nonPerTestDifferences.length} line(s) that are ` +
      `not per-test lines; the claim under test is falsified`,
  );
  assert.equal(diff.allDifferingArePerTest, true);
});

test("the fixture's own output is present and identical in both shapes", () => {
  const { pipe, pty, ownOutputsIdentical } = probeResult();
  const knobs = SMOKE_KNOBS;

  // Present: the counts prove we compared the fixture, not two empty outputs.
  const stageLines = pipe.lines.filter((line) =>
    /\] stage \d+\/\d+ — /.test(line),
  ).length;
  assert.equal(stageLines, knobs.files * knobs.testsPerFile * knobs.linesPerTest);
  const banners = pipe.lines.filter((line) =>
    /^=== part-\d+\.test\.ts \(file \d+ of \d+\) ===$/.test(line),
  ).length;
  assert.equal(banners, knobs.files);
  assert.equal(
    pipe.fixtureLines,
    pty.fixtureLines,
    "the fixture emitted a different number of its own lines in each shape",
  );
  for (const shape of [pipe, pty]) {
    assert.ok(
      shape.lines.some((line) => line.includes("DIAGNOSTIC_MARKER_UPSTREAM")),
      `the planted failure's diagnostic block is missing from the ${shape.shape} shape`,
    );
    assert.ok(
      shape.lines.some((line) => line.startsWith("load run summary: ")),
      `the fixture's summary block is missing from the ${shape.shape} shape`,
    );
  }

  // Identical: same own lines, in order, with per-test lines and durations out.
  assert.ok(
    ownOutputsIdentical,
    "the fixture's own output differs between the piped and pty shapes",
  );
});
