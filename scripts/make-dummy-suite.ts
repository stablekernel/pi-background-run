#!/usr/bin/env bun
/**
 * Generate the long, noisy, failing test suite used to compare a foreground
 * `bash` run against a `bgrun` job (see docs/dogfooding.md).
 *
 * WHY A GENERATOR AND NOT A CHECKED-IN SUITE
 * ------------------------------------------
 * `bun test` discovers every `*.test.ts` in the tree and does NOT respect
 * .gitignore (measured: a gitignored directory is still scanned), so a
 * checked-in fixture would run in every developer's bare `bun test` and cost
 * them minutes. The generated suite therefore lands OUTSIDE the repo by default,
 * and this script warns loudly if pointed inside it. Nothing test-shaped is
 * committed, so ordinary runs stay unaffected by construction rather than by
 * configuration.
 *
 * WHAT IT GENERATES
 * -----------------
 * A suite that is long, noisy, structured like a real runner's output, and fails
 * somewhere easy to miss:
 *   - LONG: every test awaits one chain shared through globalThis, so the total
 *     wall-clock is sleeps x tests however the runner schedules them. (bun 1.3.6
 *     happens to run these sequentially, but the chain makes the duration
 *     independent of that: a concurrent scheduler would otherwise collapse it.)
 *   - NOISY: each test logs DUMMY_LINES_PER_TEST lines (2 by default), so a run
 *     produces hundreds to thousands of lines without being a per-test drip: each
 *     file opens with a banner, and the run closes with a summary block.
 *   - FAILING: one test in the middle asserts a planted marker pair and prints a
 *     full assertion-failure block (expected vs received, stack trace naming the
 *     generated file and line), so the failure sits far from both ends of the
 *     output and looks like one a real suite would emit.
 *
 * USAGE
 * -----
 *   bun scripts/make-dummy-suite.ts                      # ~180s at the default density
 *   DUMMY_SLEEP_MS=20 bun scripts/make-dummy-suite.ts    # fast smoke version
 *   DUMMY_FAIL_FAST=1 DUMMY_SLEEP_MS=20 bun scripts/make-dummy-suite.ts
 *   bun test /tmp/pi-bgrun-dummy-suite                   # run the suite
 *
 * TUNABLES AND THE AXIS EACH ONE ISOLATES
 * ---------------------------------------
 * The comparison is not a single number, so each knob moves one axis of the
 * methodology while the others are held fixed:
 *   - DUMMY_SLEEP_MS [600] — the TIME axis. The sleeps are the wall-clock cost a
 *     background job is supposed to absorb; scaling them scales the run without
 *     touching its volume or where it fails.
 *   - DUMMY_LINES_PER_TEST [2] — the VOLUME axis. How noisy a run is, independent
 *     of how long it takes. 2 lines matches a normal `bun test` reporting density
 *     (~1–1.5 lines per test); 8 is the verbose/CI-log mode this fixture was
 *     FIRST measured at, kept as a knob so a volume-only effect is not mistaken
 *     for a time effect.
 *   - DUMMY_FILES [10], DUMMY_TESTS_PER_FILE [30] — how the volume is distributed
 *     across files, i.e. the shape of the run rather than its size.
 *   - DUMMY_FAIL_FILE [5], DUMMY_FAIL_STEP [15] — the FAILURE POSITION. Where in
 *     the run the planted failure lands, so a measurement can tell "the tool
 *     survived a long run" apart from "the tool survived a long run up to the
 *     failure".
 *   - DUMMY_FAIL_FAST [0] — the cost of a failure. 0 lets the suite run to the
 *     end after the failure (the default, and what a real test command does if it
 *     does not stop early). 1 collapses the run after the planted failure: every
 *     later test short-circuits with a single "skipped" line, so wall-clock ends
 *     near the failure instead of at the end. That is the regime where the very
 *     property a background job exploits — the run is long — disappears, so it is
 *     where bgrun should NOT be expected to win.
 *   - DUMMY_OUT_DIR [<system tmpdir>/pi-bgrun-dummy-suite] — where the suite is
 *     written; outside the repo by default and guarded against the repo.
 *
 * All earlier measurements of this fixture used 8 lines per test. Anything quoted
 * from those runs must say so, because the default density is now 2.
 */
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Canonicalise through symlinks and case, because BOTH sides of the in-repo check
// must agree: `import.meta.url` arrives symlink-resolved from Bun (/tmp becomes
// /private/tmp on macOS), while a user-supplied DUMMY_OUT_DIR does not. Comparing a
// canonical path against an unresolved one let a symlinked or case-variant spelling
// slip past the guard — and the rmSync below would then empty that directory.
function canonical(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  let real = head;
  try {
    real = realpathSync(head);
  } catch {
    // Fall back to the resolved form if the filesystem refuses (permissions, race).
  }
  return tail.length > 0 ? join(real, ...tail) : real;
}

// Text that lands inside the generated file's template literals survives one more
// round of interpolation, so escape the two sequences the generated code would
// otherwise re-evaluate (a backtick would end the literal; ${ would interpolate).
function escapeForTemplate(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

const repoRoot = canonical(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const outDir = resolve(
  process.env.DUMMY_OUT_DIR ?? join(tmpdir(), "pi-bgrun-dummy-suite"),
);
const sleepMs = Number(process.env.DUMMY_SLEEP_MS ?? 600);
const files = Number(process.env.DUMMY_FILES ?? 10);
const perFile = Number(process.env.DUMMY_TESTS_PER_FILE ?? 30);
const failFile = Number(process.env.DUMMY_FAIL_FILE ?? 5);
const failStep = Number(process.env.DUMMY_FAIL_STEP ?? 15);
const linesPerTest = Number(process.env.DUMMY_LINES_PER_TEST ?? 2);
const failFast = Number(process.env.DUMMY_FAIL_FAST ?? 0);

for (const [name, value] of Object.entries({
  sleepMs,
  files,
  perFile,
  failFile,
  failStep,
  linesPerTest,
})) {
  if (!Number.isInteger(value) || value < 1) {
    console.error(`error: ${name} must be a positive integer (got ${value})`);
    process.exit(2);
  }
}
// Fail-fast is a boolean switch, not a count: anything other than 0/1 would be a
// typo silently ignored by the generated `=== 1` test.
if (failFast !== 0 && failFast !== 1) {
  console.error(`error: DUMMY_FAIL_FAST must be 0 or 1 (got ${failFast})`);
  process.exit(2);
}
// The planted failure IS the fixture: a run that passes while this script's report
// claims it fails would quietly invalidate whatever used it.
if (failFile > files || failStep > perFile) {
  console.error(
    `error: the planted failure must land inside the suite — DUMMY_FAIL_FILE is ${failFile} of ${files} files and DUMMY_FAIL_STEP is ${failStep} of ${perFile} tests.\n` +
      "       Outside that range the generated suite passes, and anything measuring\n" +
      "       it would be measuring the wrong run.",
  );
  process.exit(2);
}

// Fatal by default, not a warning: this script CLEARS its output directory before
// writing, so pointing it at the repo can delete tracked files — and the failure is
// silent, because everything after it works.
if (
  canonical(outDir) === repoRoot ||
  canonical(outDir).startsWith(repoRoot + sep)
) {
  const detail =
    `${outDir} resolves inside the repo (${repoRoot}).\n` +
    "  `bun test` discovers *.test.ts anywhere in the tree and does not respect\n" +
    "  .gitignore, so a bare `bun test` would then run this suite too — and this\n" +
    "  script clears its output directory before writing, so pointing it at the\n" +
    "  repo can delete tracked files.\n" +
    "  Unset DUMMY_OUT_DIR to write outside the repo (the default), or set\n" +
    "  DUMMY_ALLOW_IN_REPO=1 if you really mean to generate inside it.";
  if (process.env.DUMMY_ALLOW_IN_REPO === "1") {
    console.warn(`warning: ${detail}`);
  } else {
    console.error(`error: ${detail}`);
    process.exit(2);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const total = files * perFile;

for (let i = 1; i <= files; i++) {
  const n = String(i).padStart(2, "0");
  const failing = i === failFile;
  const filePath = join(outDir, `part-${n}.test.ts`);
  const failStepLabel = String(failStep).padStart(2, "0");

  // A full assertion failure, not a one-liner: the fixture's failure should cost
  // the lines a real one costs, so measurements of failing output are not flattered
  // by a terse stub. The markers are exact strings other measurements grep for.
  const failureBlock = escapeForTemplate(
    [
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:",
      "+ actual - expected",
      "",
      "  {",
      '+   actual: "DIAGNOSTIC_MARKER_UPSTREAM",',
      "+   got: 1",
      '-   expected: "DIAGNOSTIC_MARKER_DOWNSTREAM",',
      "-   got: 2",
      "  }",
      "",
      `    at TestContext.<anonymous> (${filePath}:__FAIL_LINE__:9)`,
      "    at Test.runInAsyncScope (node:async_hooks:206:9)",
      "    at Test.run (node:internal/test_runner/test:773:25)",
      "    at Test.start (node:internal/test_runner/test:672:17)",
      "    at node:internal/test_runner/test:1175:29",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "",
      `load part ${n} > step ${failStepLabel}`,
      "  the two diagnostic markers must match; they did not, so the load run stops here.",
    ].join("\n"),
  );

  // The counters come from the run, not from arithmetic over the knobs: the runner
  // picks its own file order, so only the generated code knows how many tests ran
  // before the failure and how many short-circuited. Deliberately NOT escaped — the
  // `${...}` here must stay live so the generated file interpolates them at runtime.
  const summaryBlock = [
    "──────────────────────────────────────────────",
    `load run summary: ${files} files, ${total} tests`,
    "  pass  ${g.__passed ?? 0}",
    "  fail  ${g.__failed === true ? 1 : 0}",
    "  skip  ${g.__skipped ?? 0}",
    `the planted failure is part ${String(failFile).padStart(2, "0")} step ${failStepLabel}; its markers are the comparison pair`,
    "──────────────────────────────────────────────",
  ].join("\n");

  let content = `// Generated by scripts/make-dummy-suite.ts — do not edit; regenerate instead.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// Fixture purpose: this suite exists to occupy real wall-clock time and produce
// real output volume. The delay IS the thing under measurement, so a fake timer
// cannot stand in for it — hence a genuine setTimeout. It is generated outside
// the repo so it never runs in CI or in a bare \`bun test\`.
//
// ONE CHAIN, SHARED VIA globalThis: every test awaits this promise, so the run's
// wall-clock is sleeps x tests however the runner schedules them. Without it a
// concurrent scheduler would overlap the delays and collapse the measurement.
const g = globalThis as unknown as {
  __chain?: Promise<void>;
  __failed?: boolean;
  __done?: number;
  __passed?: number;
  __skipped?: number;
};
function step(): Promise<void> {
  const hold = new Promise<void>((resolve) => setTimeout(resolve, ${sleepMs}));
  g.__chain = (g.__chain ?? Promise.resolve()).then(() => hold);
  return g.__chain;
}

describe("load part ${n}", () => {
  before(() => {
    console.log(\`=== part-${n}.test.ts (file ${i} of ${files}) ===\`);
  });
  for (let k = 1; k <= ${perFile}; k++) {
    const which = k;
    test(\`step \${String(which).padStart(2, "0")}\`, async () => {
      try {
${
  failFast === 1
    ? `        if (g.__failed === true) {
          g.__skipped = (g.__skipped ?? 0) + 1;
          console.log(\`[part ${n} step \${which}] skipped — the run already failed\`);
          return;
        }
`
    : ""
}        for (let line = 1; line <= ${linesPerTest}; line++) {
          console.log(\`[part ${n} step \${which}] stage \${line}/${linesPerTest} — building, linking, checking\`);
        }
${
  failing
    ? `        if (which === ${failStep}) {
          g.__failed = true;
          console.error(\`${failureBlock}\`);
          assert.deepEqual(
            { actual: "DIAGNOSTIC_MARKER_UPSTREAM", got: 1 },
            { expected: "DIAGNOSTIC_MARKER_DOWNSTREAM", got: 2 },
          );
        }
`
    : ""
}        await step();
        g.__passed = (g.__passed ?? 0) + 1;
      } finally {
        // The counter, not the runner, places the summary: whichever test runs
        // last prints it, so the block lands at the end of the fixture's output
        // however the runner orders the files.
        g.__done = (g.__done ?? 0) + 1;
        if (g.__done === ${total}) {
          console.log(\`${summaryBlock}\`);
        }
      }
    });
  }
});
`;

  if (failing) {
    // The stack trace must name the line the assertion actually sits on; we only
    // know that once the whole file is assembled, so substitute the placeholder.
    const failLine =
      content.split("\n").findIndex((line) => line.includes("assert.deepEqual")) + 1;
    content = content.replace("__FAIL_LINE__", String(failLine));
  }

  writeFileSync(filePath, content);
}

console.log(
  `generated ${files} files in ${outDir}\n` +
    `  tests:    ${total} (${files} files x ${perFile})\n` +
    `  density:  ${linesPerTest} log lines/test${
      linesPerTest === 8 ? " (the original fixture density)" : ""
    }\n` +
    `  runtime:  ~${((sleepMs * total) / 1000).toFixed(0)}s (${sleepMs}ms x ${total})\n` +
    `  output:   ~${total * linesPerTest} log lines, plus per-file banners and the summary\n` +
    `  failing:  part ${String(failFile).padStart(2, "0")} step ${failStep}, exit 1` +
    `${failFast === 1 ? " (fail-fast: the run stops there)" : ""}\n` +
    `  run it:   bun test ${outDir}`,
);
