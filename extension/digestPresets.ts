/**
 * Shipped digest presets for pi-bgrun's opt-in digest scorecards.
 *
 * Pure data: each preset is a POSIX-sh command that receives the job's log
 * path as `$1` and prints a short pass/fail scorecard. Every command ends in
 * `head -N` so output is bounded no matter what the log contains. Presets are
 * consumed via `resolveDigest()`; they only ever run for trust-gated projects
 * that explicitly opted in via the `digest` config section (see
 * extension/index.ts). Nothing here runs unless configured — no built-in
 * pattern guessing.
 */

export interface DigestPreset {
  id: string;
  description: string;
  command: string;
}

export const DIGEST_PRESETS: DigestPreset[] = [
  {
    id: "go-test",
    description:
      "Go test output: package ok/FAIL counts + failing test names",
    // Count `^ok `/`^FAIL` package lines, then list `--- FAIL: TestX` names
    // (duration suffix stripped). Ends in head.
    command:
      'printf \'pass: %s  fail: %s\\n\' "$(grep -c \'^ok \' "$1")" "$(awk \'/^FAIL\\t/ {n++} END {print n + 0}\' "$1")"; grep \'^--- FAIL: \' "$1" | sed \'s/^--- FAIL: //; s/ (.*//\' | sort -u | head -10',
  },
  {
    id: "jest",
    description: "Jest output: Tests/Test Suites summary + failed test names",
    // Jest prints `Tests:`/`Test Suites:` summary lines (with or without
    // color) and marks individual failures with `●` (default reporter) or
    // `✕`/`×` (verbose). Strip the leading bullet so names stay readable.
    command:
      'grep -E \'^(Test Suites|Tests):\' "$1"; grep -E \'●|✕|×\' "$1" | awk \'{sub(/^ *[^A-Za-z0-9]*/, ""); if ($0 != "") print}\' | sort -u | head -10',
  },
  {
    id: "pytest",
    description:
      "pytest output: final passed/failed/error summary line + FAILED test ids",
    // The short summary line looks like `===== 2 failed, 3 passed in 0.5s ===`;
    // with -rA/-rf each failure also gets a `FAILED tests/test_x.py::test_y` line.
    command:
      'grep -E \'^=+ [0-9]+ (passed|failed|error)\' "$1"; grep \'^FAILED \' "$1" | awk \'{print $2}\' | sort -u | head -10',
  },
  {
    id: "junit-xml",
    description:
      "JUnit XML: <failure>/<error> counts + failing testcase names",
    // Count failure/error elements (attributes like failures="0" don't match —
    // they lack the `<`), then pull the enclosing testcase's name attribute
    // (leading space in the regex avoids matching `classname="..."`).
    command:
      'printf \'failures: %s  errors: %s\\n\' "$(grep -o \'<failure\' "$1" | wc -l | tr -d \' \')" "$(grep -o \'<error\' "$1" | wc -l | tr -d \' \')"; awk \'/<testcase/{if (match($0, / name="[^"]*"/)) {name = substr($0, RSTART + 7, RLENGTH - 8)}} /<failure|<error/{if (name != "") print name}\' "$1" | sort -u | head -10',
  },
];

export const DIGEST_PRESET_IDS = DIGEST_PRESETS.map((p) => p.id);

/** A digest resolved to a concrete sh command (log path arrives as $1). */
export type ResolvedDigest =
  | { kind: "preset"; command: string }
  | { kind: "command"; command: string };

/**
 * Resolve a normalized digest config (from resolveConfig) into the command to
 * run. When both preset and command are configured, the preset wins — a
 * curated, shipped preset is preferred over a hand-rolled command pointing at
 * the same format. Returns undefined when nothing usable is configured.
 */
export function resolveDigest(
  digest: { preset?: string; command?: string } | undefined,
): ResolvedDigest | undefined {
  if (!digest) return undefined;
  if (digest.preset) {
    const preset = DIGEST_PRESETS.find((p) => p.id === digest.preset);
    if (preset) return { kind: "preset", command: preset.command };
  }
  if (digest.command) return { kind: "command", command: digest.command };
  return undefined;
}
