#!/usr/bin/env bun
/**
 * pty-shape.ts — decide whether bun's test reporter presents a different output
 * SHAPE when its stdout is a pseudo-terminal rather than a pipe.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dogfooding benchmark (`docs/dogfooding.md`) compares a foreground `bash`
 * run of the dummy suite against a bgrun handoff, and its volume claims all count
 * the lines an agent had to read. That count is only meaningful if "the same
 * suite" produces the same shape in every cell. It might not: bun's reporter has
 * a TTY path and a pipe path, and the unverified claim is that it emits a
 * per-test line — one per test, carrying a duration — when stdout is a terminal
 * but not when it is a pipe. If true, a run captured to a file and a run shown on
 * a terminal differ in volume, and every benchmark number would depend on which
 * one was measured.
 *
 * What settles it is not the line COUNT but the DIFF. A count alone cannot tell a
 * reporter difference from fixture noise or from a nondeterministic duration; the
 * probe therefore runs the exact same fixture twice, identical in everything but
 * where stdout points, and asks a sharper question: are the lines that exist in
 * one shape and not the other *exactly* the per-test lines? Only then is the
 * shape difference the one the hypothesis names; a difference anywhere else
 * falsifies it.
 *
 * CONFOUND WORTH KNOWING: bun suppresses the per-test lines entirely when it
 * detects an agent environment (`AGENT` or `CLAUDECODE` in the environment), in
 * both shapes. So the answer to "is the reporter terminal-aware?" is observable
 * only when those variables are absent; under them the two shapes are identical.
 * The probe deliberately measures the AMBIENT environment — that is the shape the
 * fixture really presents to the agent in every other cell — and reports what it
 * finds rather than sanitising it away.
 *
 * Runs as `bun scripts/pty-shape.ts`, generating a smoke-scale fixture through
 * `scripts/make-dummy-suite.ts` (never modified) into a temp dir outside the repo.
 * Exits non-zero when the expected relationship fails, so it can be a check.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** ANSI CSI/OSC escapes and the single-character escapes a TTY reporter emits. */
const ANSI_PATTERN =
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** bun's per-test duration, e.g. `[0.47ms]`. Nondeterministic; normalise before diffing. */
const DURATION_PATTERN = /\[\d+(?:\.\d+)?ms\]/g;

/** A bun per-test line: `(pass) name [dur]` (pipe, agent) or `✓ name` (colored TTY). */
const PER_TEST_PATTERN = /^(?:\((?:pass|fail)\)|[✓✗])\s/;

/**
 * A line the FIXTURE itself prints, by unambiguous signature: stage lines, the
 * banner, the summary block and the planted-failure line. The failure block is
 * emitted through console.error and is checked by the "own output" comparison
 * rather than by a pattern that would also match bun's own error rendering.
 */
const FIXTURE_LINE_PATTERN =
  /^(?:=== part-\d+\.test\.ts \(file \d+ of \d+\) ===|─+|load run summary: \d+ files, \d+ tests|  (?:pass|fail|skip)  \d+|the planted failure is part \d+ step \d+.*)$|^\[part \d+ step \d+\] (?:stage \d+\/\d+ — |skipped — )/;

/** Lines of the planted failure's diagnostic block, whichever side printed them. */
const FAILURE_BLOCK_PATTERN =
  /DIAGNOSTIC_MARKER|ERR_ASSERTION|the two diagnostic markers must match/;

export type PtyMechanism = "bsd" | "util-linux";

export interface PtyRunner {
  mechanism: PtyMechanism;
  /** Wrap an argv so it runs with stdout attached to a pseudo-terminal. */
  wrap(argv: string[]): string[];
}

export interface ShapeFacts {
  shape: "pipe" | "pty";
  exitCode: number;
  totalLines: number;
  perTestLines: number;
  fixtureLines: number;
  /** total − per-test − fixture: bun's own framing and error rendering. */
  otherLines: number;
  failureBlockStart: number;
  failureBlockEnd: number;
  /** Lines from the end of the diagnostic block to the end of the output. */
  failureDistance: number;
  lines: string[];
}

export interface DiffFacts {
  onlyInPty: string[];
  onlyInPipe: string[];
  differingLines: number;
  nonPerTestDifferences: string[];
  allDifferingArePerTest: boolean;
}

export interface ProbeResult {
  fixtureDir: string;
  mechanism: PtyMechanism;
  pipe: ShapeFacts;
  pty: ShapeFacts;
  diff: DiffFacts;
  /** The two outputs with per-test lines removed, in order. */
  ownOutputsIdentical: boolean;
}

export interface FixtureKnobs {
  files: number;
  testsPerFile: number;
  linesPerTest: number;
  failFile: number;
  failStep: number;
  sleepMs: number;
}

/** The scale the probe runs at: seconds on CI, not minutes. */
export const SMOKE_KNOBS: FixtureKnobs = {
  files: 2,
  testsPerFile: 3,
  linesPerTest: 2,
  failFile: 2,
  failStep: 2,
  sleepMs: 10,
};

/**
 * Strip the terminal down to plain lines so the two shapes can be compared:
 * ANSI escapes, pty CRLF, script(1)'s leading EOT, and trailing blank lines.
 */
export function normalizeToLines(raw: string): string[] {
  const cleaned = raw
    // BSD `script -q` echoes the terminal's EOT as the literal text `^D` plus
    // backspaces that erase it; util-linux does not. Remove it so the leading
    // reporter line is compared, not the wrapper's own terminal noise.
    .replace(/\^D\x08*/g, "")
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const lines = cleaned.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines;
}

/** Exported as the probe's definition of a per-test line; the test asserts on it. */
export function isPerTestLine(line: string): boolean {
  return PER_TEST_PATTERN.test(line);
}

function shellJoin(argv: string[]): string {
  return argv
    .map((arg) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
        ? arg
        : `'${arg.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

/**
 * Find a working pty mechanism. macOS/BSD's `script` takes the command as
 * trailing argv; util-linux's takes it with `-c`. Each candidate is proved with a
 * marker command, so a form that silently runs nothing cannot be mistaken for
 * one that works. Returns null when neither works, so callers can fail loudly.
 */
export function detectPtyRunner(): PtyRunner | null {
  const probe = ["sh", "-c", "test -t 1 && echo PTY_PROBE_TTY"];
  const candidates: {
    mechanism: PtyMechanism;
    wrap(argv: string[]): string[];
  }[] = [
    {
      mechanism: "bsd",
      wrap: (argv) => ["script", "-q", "/dev/null", ...argv],
    },
    {
      mechanism: "util-linux",
      wrap: (argv) => ["script", "-qec", shellJoin(argv), "/dev/null"],
    },
  ];

  for (const candidate of candidates) {
    const argv = candidate.wrap(probe);
    const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status === 0 && out.includes("PTY_PROBE_TTY")) {
      return { mechanism: candidate.mechanism, wrap: candidate.wrap };
    }
  }
  return null;
}

/** Generate the dummy suite at the given scale into `outDir` (outside the repo). */
export function generateFixture(outDir: string, knobs: FixtureKnobs): void {
  const res = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "make-dummy-suite.ts")],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DUMMY_OUT_DIR: outDir,
        DUMMY_FILES: String(knobs.files),
        DUMMY_TESTS_PER_FILE: String(knobs.testsPerFile),
        DUMMY_LINES_PER_TEST: String(knobs.linesPerTest),
        DUMMY_FAIL_FILE: String(knobs.failFile),
        DUMMY_FAIL_STEP: String(knobs.failStep),
        DUMMY_SLEEP_MS: String(knobs.sleepMs),
        DUMMY_FAIL_FAST: "0",
      },
    },
  );
  if (res.status !== 0) {
    throw new Error(
      `fixture generation failed (exit ${res.status}):\n${res.stdout ?? ""}${res.stderr ?? ""}`,
    );
  }
}

/** Run `argv` with stdout and stderr redirected (in order) to `outPath`. */
function captureToFile(argv: string[], outPath: string, cwd: string): number {
  const fd = openSync(outPath, "w");
  try {
    const res = spawnSync(argv[0], argv.slice(1), {
      cwd,
      stdio: ["ignore", fd, fd],
    });
    if (res.error) {
      throw res.error;
    }
    return res.status ?? -1;
  } finally {
    closeSync(fd);
  }
}

function analyze(shape: "pipe" | "pty", raw: string, exitCode: number): ShapeFacts {
  const lines = normalizeToLines(raw);
  let perTestLines = 0;
  let fixtureLines = 0;
  let failureBlockStart = -1;
  let failureBlockEnd = -1;
  lines.forEach((line, index) => {
    if (isPerTestLine(line)) perTestLines += 1;
    if (FIXTURE_LINE_PATTERN.test(line)) fixtureLines += 1;
    if (FAILURE_BLOCK_PATTERN.test(line)) {
      if (failureBlockStart === -1) failureBlockStart = index;
      failureBlockEnd = index;
    }
  });
  return {
    shape,
    exitCode,
    totalLines: lines.length,
    perTestLines,
    fixtureLines,
    otherLines: lines.length - perTestLines - fixtureLines,
    failureBlockStart,
    failureBlockEnd,
    failureDistance:
      failureBlockEnd === -1 ? -1 : lines.length - 1 - failureBlockEnd,
    lines,
  };
}

/**
 * Multiset difference of the two normalised outputs, classified by whether every
 * surplus line is a per-test line. Durations are normalised first, because they
 * are nondeterministic and would otherwise masquerade as shape differences.
 */
export function computeDiff(ptyLines: string[], pipeLines: string[]): DiffFacts {
  const pty = ptyLines.map((line) => line.replace(DURATION_PATTERN, "[<dur>]"));
  const pipe = pipeLines.map((line) => line.replace(DURATION_PATTERN, "[<dur>]"));

  const tally = (lines: string[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const line of lines) counts[line] = (counts[line] ?? 0) + 1;
    return counts;
  };
  const ptyCounts = tally(pty);
  const pipeCounts = tally(pipe);

  const surplus = (
    from: Record<string, number>,
    other: Record<string, number>,
  ): string[] => {
    const out: string[] = [];
    for (const [line, n] of Object.entries(from)) {
      const extra = n - (other[line] ?? 0);
      for (let i = 0; i < extra; i++) out.push(line);
    }
    return out;
  };

  const onlyInPty = surplus(ptyCounts, pipeCounts);
  const onlyInPipe = surplus(pipeCounts, ptyCounts);
  const nonPerTestDifferences = [...onlyInPty, ...onlyInPipe].filter(
    (line) => !isPerTestLine(line),
  );
  return {
    onlyInPty,
    onlyInPipe,
    differingLines: onlyInPty.length + onlyInPipe.length,
    nonPerTestDifferences,
    allDifferingArePerTest: nonPerTestDifferences.length === 0,
  };
}

export interface RunProbeOptions {
  fixtureDir?: string;
  knobs?: FixtureKnobs;
}

/** Generate the fixture and run it in both shapes; the whole probe, reusable. */
export function runProbe(options: RunProbeOptions = {}): ProbeResult {
  const knobs = options.knobs ?? SMOKE_KNOBS;
  const fixtureDir =
    options.fixtureDir ?? mkdtempSync(join(tmpdir(), "pi-bgrun-pty-shape-"));
  const runner = detectPtyRunner();
  if (!runner) {
    throw new Error(
      "no pseudo-terminal mechanism found: neither `script -q /dev/null <cmd…>` " +
        "(BSD/macOS) nor `script -qec \"<cmd>\" /dev/null` (util-linux) worked. " +
        "The probe cannot run and must not silently pass — install a working " +
        "`script(1)` (util-linux or BSD) and re-run.",
    );
  }

  generateFixture(fixtureDir, knobs);

  const command = [process.execPath, "test", fixtureDir];
  const pipePath = join(fixtureDir, "run.pipe.log");
  const ptyPath = join(fixtureDir, "run.pty.log");

  const pipeExit = captureToFile(command, pipePath, repoRoot);
  const ptyExit = captureToFile(runner.wrap(command), ptyPath, repoRoot);

  const pipe = analyze("pipe", readFileSync(pipePath, "utf8"), pipeExit);
  const pty = analyze("pty", readFileSync(ptyPath, "utf8"), ptyExit);
  // Durations are nondeterministic, so they are normalised before any comparison
  // of the two runs; otherwise a millisecond of jitter reads as a shape difference.
  const own = (shape: ShapeFacts): string[] =>
    shape.lines
      .filter((line) => !isPerTestLine(line))
      .map((line) => line.replace(DURATION_PATTERN, "[<dur>]"));
  const ptyOwn = own(pty);
  const pipeOwn = own(pipe);

  return {
    fixtureDir,
    mechanism: runner.mechanism,
    pipe,
    pty,
    diff: computeDiff(pty.lines, pipe.lines),
    ownOutputsIdentical:
      ptyOwn.length === pipeOwn.length &&
      ptyOwn.every((line, i) => line === pipeOwn[i]),
  };
}

/** Print the probe's findings and return the process exit code. */
export function reportProbe(result: ProbeResult, knobs: FixtureKnobs): number {
  const { pipe, pty, diff } = result;
  console.log("pty-fixture probe — is bun's test reporter terminal-aware?\n");
  console.log(
    `fixture:   ${result.fixtureDir}\n` +
      `           ${knobs.files} files x ${knobs.testsPerFile} tests, ` +
      `${knobs.linesPerTest} lines/test, planted failure part ` +
      `${String(knobs.failFile).padStart(2, "0")} step ${String(knobs.failStep).padStart(2, "0")}\n` +
      `pty:       ${result.mechanism} \`script(1)\`\n`,
  );
  console.log(
    "shape   exit  total  per-test  fixture  after-failure\n" +
      "-----  -----  -----  --------  -------  -------------",
  );
  for (const facts of [pipe, pty]) {
    const distance =
      facts.failureDistance === -1 ? "n/a" : String(facts.failureDistance);
    console.log(
      `${facts.shape.padEnd(4)}  ${String(facts.exitCode).padStart(4)}  ` +
        `${String(facts.totalLines).padStart(5)}  ` +
        `${String(facts.perTestLines).padStart(8)}  ` +
        `${String(facts.fixtureLines).padStart(7)}  ` +
        `${distance.padStart(9)}`,
    );
  }
  console.log();

  console.log(
    `diff:      ${diff.differingLines} line(s) differ ` +
      `(${diff.onlyInPty.length} only in pty, ${diff.onlyInPipe.length} only in pipe)`,
  );
  console.log(
    `           all differing lines are per-test lines: ${
      diff.allDifferingArePerTest ? "yes" : "NO"
    }`,
  );
  if (diff.differingLines > 0) {
    const samples = [
      ...diff.onlyInPty.slice(0, 3).map((line) => `only pty  | ${line}`),
      ...diff.onlyInPipe.slice(0, 3).map((line) => `only pipe | ${line}`),
    ];
    console.log(`           sample differing lines:\n${samples.map((s) => `             ${s}`).join("\n")}`);
  }
  if (!diff.allDifferingArePerTest) {
    console.log("           non-per-test differences:");
    for (const line of diff.nonPerTestDifferences.slice(0, 20)) {
      console.log(`             | ${line}`);
    }
    const remaining = diff.nonPerTestDifferences.length - 20;
    if (remaining > 0) console.log(`             … ${remaining} more`);
  }
  console.log(
    `           fixture's own output identical in both shapes: ${
      result.ownOutputsIdentical ? "yes" : "NO"
    }\n`,
  );

  const holds =
    pty.totalLines >= pipe.totalLines &&
    diff.allDifferingArePerTest &&
    result.ownOutputsIdentical;
  console.log(
    holds
      ? "PASS: the pty shape is never smaller, every line that differs is a per-test\n" +
          "      line, and the fixture's own output is identical in both shapes."
      : "FAIL: the expected relationship between the shapes does not hold — see above.",
  );
  return holds ? 0 : 1;
}

if ((import.meta as { main?: boolean }).main) {
  try {
    process.exit(reportProbe(runProbe(), SMOKE_KNOBS));
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
