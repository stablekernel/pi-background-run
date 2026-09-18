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
 /**
  * Advisory only — the conventional job `type` this preset is meant for,
  * used by docs and the digest-config skill when scaffolding a config
  * (e.g. `{ "type": "test", "preset": "go-test" }`). It carries NO runtime
  * semantics: a preset entry never selects itself by type; the project's
  * config still declares the `type` on each entry.
  */
 suggestedType: string;
}

export const DIGEST_PRESETS: DigestPreset[] = [
 {
  id: "go-test",
  description: "Go test output: package ok/FAIL counts + failing test names",
  suggestedType: "test",
  // Count `^ok `/`^FAIL` package lines, then list `--- FAIL: TestX` names
  // (duration suffix stripped). Ends in head.
  command:
   "printf 'pass: %s  fail: %s\\n' \"$(grep -c '^ok ' \"$1\")\" \"$(awk '/^FAIL\\t/ {n++} END {print n + 0}' \"$1\")\"; grep '^--- FAIL: ' \"$1\" | sed 's/^--- FAIL: //; s/ (.*//' | sort -u | head -10",
 },
 {
  id: "jest",
  description: "Jest output: Tests/Test Suites summary + failed test names",
  suggestedType: "test",
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
  suggestedType: "test",
  // The short summary line looks like `===== 2 failed, 3 passed in 0.5s ===`;
  // with -rA/-rf each failure also gets a `FAILED tests/test_x.py::test_y` line.
  command:
   "grep -E '^=+ [0-9]+ (passed|failed|error)' \"$1\"; grep '^FAILED ' \"$1\" | awk '{print $2}' | sort -u | head -10",
 },
 {
  id: "junit-xml",
  description: "JUnit XML: <failure>/<error> counts + failing testcase names",
  suggestedType: "test",
  // Count failure/error elements (attributes like failures="0" don't match —
  // they lack the `<`), then pull the enclosing testcase's name attribute.
  // Real pytest --junitxml emits the whole document on ONE line, so the scan
  // is record-based (`RS='<testcase'`, not line-based); it trims each record at
  // `</testcase>` and matches `[[:space:]]name="` so it never picks up
  // `classname="..."` nor a `<failure` from text after the element.
  command:
   "printf 'failures: %s  errors: %s\\n' \"$(grep -o '<failure' \"$1\" | wc -l | tr -d ' ')\" \"$(grep -o '<error' \"$1\" | wc -l | tr -d ' ')\"; awk -v RS='<testcase' 'NR>1 { r=$0; e=index(r,\"</testcase>\"); if (e) r=substr(r,1,e-1); if (match(r,/[[:space:]]name=\"[^\"]*\"/)) { n=substr(r,RSTART+7,RLENGTH-8); if (r ~ /<failure|<error/) print n } }' \"$1\" | sort -u | head -10",
 },
];

export const DIGEST_PRESET_IDS = DIGEST_PRESETS.map((p) => p.id);

/**
 * Matchers selecting which jobs a digest entry applies to. Both are glob
 * patterns tested against the bgrun job's `name` (optional) and command line
 * respectively. `*` matches any run of characters (including none) and `?`
 * matches exactly one UTF-16 code unit; everything else is literal, and `\`
 * escapes the next character so `\*` / `\?` / `\\` match literally. Matching
 * is case-insensitive and **whole-string** (write `*text*` for a substring).
 * An absent, empty, or blank `match` matches every job.
 */
export interface DigestMatch {
 name?: string;
 command?: string;
}

/**
 * One scorecard entry in the `digest` config: an optional job `type`, an
 * optional `match`, an optional wake label, and either a shipped preset id or
 * a custom sh command. Config normalizes to an ordered list of these; the
 * first entry that matches a job wins (put the default entry last).
 *
 * `type` and `match` compose (AND): when both are present the entry matches
 * only a job with that exact type that ALSO satisfies the glob `match`. Use
 * `type` for a first-class job type declared at spawn time; use `match` alone
 * as the fallback selector for jobs without a type. An entry with neither
 * selector matches every job.
 */
export interface DigestEntry {
 type?: string;
 match?: DigestMatch;
 label?: string;
 preset?: string;
 command?: string;
}

/**
 * The job a digest entry is selected against at wake time. `type` is the
 * job's agent-declared type (e.g. "test", "build"), matched exactly
 * (case-insensitively) against type-gated entries before the glob fallback.
 */
export interface DigestJobTarget {
 name?: string;
 type?: string;
 command: string;
}

/** A digest entry resolved against a concrete job. */
export interface SelectedDigest {
 command: string;
 label: string;
}

/**
 * Resolve a normalized digest entry into the concrete sh command to run (the
 * job's log path arrives as `$1`). When both `preset` and `command` are
 * configured, the preset wins — a curated, shipped preset is preferred over a
 * hand-rolled command pointing at the same format. Returns undefined when
 * nothing usable is configured.
 */
export function resolveDigest(
 digest: { preset?: string; command?: string } | undefined,
): string | undefined {
 if (!digest) return undefined;
 if (digest.preset) {
  const preset = DIGEST_PRESETS.find((p) => p.id === digest.preset);
  if (preset) return preset.command;
 }
 if (digest.command) return digest.command;
 return undefined;
}

/**
 * Case-insensitive, whole-string glob match used by `match.name` /
 * `match.command`. `*` matches any run of characters — including none, and
 * including newlines so a multi-line command still matches — and `?` matches
 * exactly one character. Every other character is literal. The pattern is
 * escaped into a regex here, so no user text can become a regex metacharacter
 * or quantifier: there is no backtracking hazard (ReDoS) and no anchoring
 * ambiguity — the match is always against the whole string.
 */
function globMatches(pattern: string, text: string): boolean {
 let re = "^";
 for (let i = 0; i < pattern.length; i++) {
  const ch = pattern[i];
  // `\` escapes the next character, so `\*` / `\?` / `\\` match literally.
  if (ch === "\\" && i + 1 < pattern.length) {
   re += escapeRegexChar(pattern[++i]);
  } else if (ch === "*") {
   re += "[\\s\\S]*";
  } else if (ch === "?") {
   re += "[\\s\\S]";
  } else {
   re += escapeRegexChar(ch);
  }
 }
 re += "$";
 return new RegExp(re, "i").test(text);
}

/** Escape one literal character for a RegExp, so it can never be a metacharacter. */
function escapeRegexChar(ch: string): string {
 return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a digest entry's glob `match` apply to this job? No `match` (or an
 * empty one) matches every job. A present `name`/`command` pattern must
 * match; `name` against a job with no name never matches. When both fields are
 * present both must match (AND). Matching is **whole-string** and
 * **case-insensitive** — so `"*unit*"` matches `"unit-tests-run3"`, while a
 * bare `"unit-tests"` matches only exactly that. This helper handles the glob
 * matcher only; `selectDigestEntry` composes it with the entry's `type` gate
 * (both must match).
 */
export function entryMatchesJob(
 entry: DigestEntry,
 target: DigestJobTarget,
): boolean {
 const match = entry.match;
 if (!match) return true;
 if (match.name === undefined && match.command === undefined) return true;
 if (match.name !== undefined) {
  if (target.name === undefined) return false;
  if (!globMatches(match.name, target.name)) return false;
 }
 if (match.command !== undefined) {
  if (!globMatches(match.command, target.command)) return false;
 }
 return true;
}

/** Terminal label when an entry sets neither `label` nor a `match.name`. */
function defaultDigestLabel(entry: DigestEntry): string {
 return entry.preset ?? "command";
}

/**
 * Wake label derived from a glob pattern: drop the (unescaped) wildcards,
 * unwrap escapes, so `*cargo*` → `cargo` and `e2e-\*` → `e2e-*`.
 */
function labelFromMatchName(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) out += pattern[++i];
    else if (ch === "*" || ch === "?") continue;
    else out += ch;
  }
  return out.trim();
}

/**
 * One-line diagnostic for the silent no-digest case: a digest IS configured
 * but no entry selected for this job. The usual causes are a `type` the agent
 * never passes (or spells differently) and a `match` glob that never fires.
 * Pure — the wake path decides whether to log it.
 */
export function digestNoMatchWarning(
 target: DigestJobTarget,
 entries: DigestEntry[],
): string {
 const declaredTypes = [
  ...new Set(
   entries.map((e) => e.type).filter((t): t is string => typeof t === "string"),
  ),
 ];
 const job =
  target.type === undefined
   ? target.name === undefined
    ? "a job with no type or name"
    : `job name "${target.name}"`
   : `job type "${target.type}"`;
 const types = declaredTypes.length
  ? ` — configured types: ${declaredTypes.join(", ")}`
  : "";
 return `[pi-bgrun] digest configured but selected no entry for ${job}${types}`;
}

/**
 * Select the digest entry for a job and resolve it to a concrete command +
 * wake label. Selection order:
 *
 *   1. Type entries first: an entry declaring `type` is eligible only for a
 *      job declaring that same type (exact, case-insensitive) AND satisfying
 *      the entry's `match` when it has one — `type` and `match` compose (AND).
 *      Checked in config order, ahead of every match entry regardless of where
 *      it sits in the list. First match wins.
 *   2. Fallback: ordered scan over entries WITHOUT a `type` — `match.name` /
 *      `match.command` globs (case-insensitive, whole-string) and no-`match`
 *      defaults. First match wins. Jobs with no type therefore behave exactly
 *      as before.
 *   3. Nothing matched → undefined (no digest).
 *
 * Label precedence: entry `label` → (type entry) the type string → (match
 * entry) the matched `match.name` → the entry's preset id (or "command"), so a
 * bare preset entry labels the wake `digest (go-test):` instead of the old
 * opaque "project-config". Returns undefined when the list is empty.
 */
export function selectDigestEntry(
 entries: DigestEntry[] | undefined,
 target: DigestJobTarget,
): SelectedDigest | undefined {
 if (!entries) return undefined;

 // First entry (in the given order) whose `match` passes and which resolves to
 // a command. Shared by the type-first pass and the fallback pass so the
 // matching/resolution rules can never drift between them.
 const pick = (
  candidates: DigestEntry[],
 ): { entry: DigestEntry; command: string } | undefined => {
  for (const entry of candidates) {
   if (!entryMatchesJob(entry, target)) continue;
   const command = resolveDigest(entry);
   if (command) return { entry, command };
  }
  return undefined;
 };

 // 1. Type-first selection. Only entries declaring a type are eligible here,
 // and only when the job declared one. A `match` on the entry, if any, must
 // also pass. Config order decides ties.
 if (target.type !== undefined) {
  const want = target.type.toLowerCase();
  const hit = pick(entries.filter((e) => e.type?.toLowerCase() === want));
  // A type-matching entry always carries a non-empty type, so `entry.type` is
  // the label fallback — no need for the preset-id default here.
  if (hit?.entry.type) {
   return { command: hit.command, label: hit.entry.label || hit.entry.type };
  }
 }

 // 2. Glob/default fallback over entries without a type.
 const hit = pick(entries.filter((e) => !e.type));
 if (hit) {
  const entry = hit.entry;
  const matchLabel =
   entry.match?.name === undefined ? "" : labelFromMatchName(entry.match.name);
  return {
   command: hit.command,
   label: entry.label || matchLabel || defaultDigestLabel(entry),
  };
 }
 return undefined;
}
