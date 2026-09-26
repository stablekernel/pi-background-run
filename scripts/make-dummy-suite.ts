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
 * A suite that is long, noisy, and fails somewhere easy to miss:
 *   - LONG: every test awaits one chain shared through globalThis, so the total
 *     wall-clock is sleeps x tests however the runner schedules them. (bun 1.3.6
 *     happens to run these sequentially, but the chain makes the duration
 *     independent of that: a concurrent scheduler would otherwise collapse it.)
 *   - NOISY: each test logs 8 lines, so a run produces thousands of lines.
 *   - FAILING: one test in the middle asserts a planted marker pair, so the
 *     failure sits far from both ends of the output.
 *
 * USAGE
 * -----
 *   bun scripts/make-dummy-suite.ts                      # ~180s, ~2,500 lines
 *   DUMMY_SLEEP_MS=20 bun scripts/make-dummy-suite.ts    # fast smoke version
 *   bun test /tmp/pi-bgrun-dummy-suite                   # run the suite
 *
 * Tunables (defaults in brackets): DUMMY_OUT_DIR
 * [<system tmpdir>/pi-bgrun-dummy-suite], DUMMY_SLEEP_MS [600], DUMMY_FILES [10],
 * DUMMY_TESTS_PER_FILE [30], DUMMY_FAIL_FILE [5], DUMMY_FAIL_STEP [15].
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

const repoRoot = canonical(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const outDir = resolve(
  process.env.DUMMY_OUT_DIR ?? join(tmpdir(), "pi-bgrun-dummy-suite"),
);
const sleepMs = Number(process.env.DUMMY_SLEEP_MS ?? 600);
const files = Number(process.env.DUMMY_FILES ?? 10);
const perFile = Number(process.env.DUMMY_TESTS_PER_FILE ?? 30);
const failFile = Number(process.env.DUMMY_FAIL_FILE ?? 5);
const failStep = Number(process.env.DUMMY_FAIL_STEP ?? 15);

for (const [name, value] of Object.entries({
  sleepMs,
  files,
  perFile,
  failFile,
  failStep,
})) {
  if (!Number.isInteger(value) || value < 1) {
    console.error(`error: ${name} must be a positive integer (got ${value})`);
    process.exit(2);
  }
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

for (let i = 1; i <= files; i++) {
  const n = String(i).padStart(2, "0");
  const failing = i === failFile;
  writeFileSync(
    join(outDir, `part-${n}.test.ts`),
    `// Generated by scripts/make-dummy-suite.ts — do not edit; regenerate instead.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Fixture purpose: this suite exists to occupy real wall-clock time and produce
// real output volume. The delay IS the thing under measurement, so a fake timer
// cannot stand in for it — hence a genuine setTimeout. It is generated outside
// the repo so it never runs in CI or in a bare \`bun test\`.
const g = globalThis as unknown as { __chain?: Promise<void> };
function step(): Promise<void> {
  const hold = new Promise<void>((resolve) => setTimeout(resolve, ${sleepMs}));
  g.__chain = (g.__chain ?? Promise.resolve()).then(() => hold);
  return g.__chain;
}

describe("load part ${n}", () => {
  for (let k = 1; k <= ${perFile}; k++) {
    const which = k;
    test(\`step \${String(which).padStart(2, "0")}\`, async () => {
      for (let line = 1; line <= 8; line++) {
        console.log(\`[part ${n} step \${which}] stage \${line}/8 — building, linking, checking\`);
      }
${
  failing
    ? `      if (which === ${failStep}) {
        assert.deepEqual(
          { actual: "DIAGNOSTIC_MARKER_UPSTREAM", got: 1 },
          { expected: "DIAGNOSTIC_MARKER_DOWNSTREAM", got: 2 },
        );
      }
`
    : ""
}      await step();
    });
  }
});
`,
  );
}

const total = files * perFile;
console.log(
  `generated ${files} files in ${outDir}\n` +
    `  tests:    ${total} (${files} files x ${perFile})\n` +
    `  runtime:  ~${((sleepMs * total) / 1000).toFixed(0)}s (${sleepMs}ms x ${total})\n` +
    `  output:   ~${total * 9} log lines, plus the summary\n` +
    `  failing:  part ${String(failFile).padStart(2, "0")} step ${failStep}, exit 1\n` +
    `  run it:   bun test ${outDir}`,
);
