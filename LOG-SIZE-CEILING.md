# bgrun: child stdout size ceiling (Option A) — implementation brief

Status: IMPLEMENTED and COMMITTED on `lloydsk/log-size-ceiling`, base
`8cba8d9`. Every commit verified green on its own tree (`tsc --noEmit` + 193/193
under bun); HEAD also verified under `node --test` (193/193, Node 24.15, ~20s).

```
e72b9aa docs: add the log-size-ceiling implementation brief
e39fb13 docs: state the ceiling's reader contract (marker flag, window and line bounds)
73a8327 ci: check the publish allowlist with npm pack
8e27f03 fix: close the log-ceiling review defects (shell parsing, hang, bounds)
f137a9f ci(release): document why publishing stays on npm, not bun publish
63a1c15 test: cover the bggrep sync fallback (the path without worker_threads)
c2f4207 test: verify the bggrep worker abort path, and fix a vacuous pathological test
1dcf365 ci: run everything on bun, drop the Node toolchain
311cd48 docs: deprecate the machine-global jobs dir; resolve home consistently
e7f0669 feat: cap background job log output, and make readers honest about it
```

Feature diff: `extension/index.ts`, `extension/index.test.ts`, `README.md`,
`skill/run-bg/SKILL.md` (+1178/−89 across the three commits, plus the CI file).
This brief is untracked — it is the PR body, not a shipped artifact.

Deviations from the design below, decided during implementation:

- The cap value is baked into the generated wrapper script rather than passed as
  argv; argv is now `$1` command, `$2` ecfile, `$3` fifo, `$4` countfile.
- If `mkfifo` fails, the wrapper falls back to the **uncapped** path — losing
  output is worse than losing the ceiling.
- `countLogLines` returns `null` (line stat omitted) rather than a partial count
  when the log exceeds its 64 MiB scan bound, and reads the tail offset from
  `fstatSync`. It also returns `null` if the file's size changes mid-scan.
- `tailBookmarks` is declared next to `jobs` (so cleanup can evict it without a
  TDZ hazard) and additionally bounded by `TAIL_BOOKMARK_CAP = 1000` via a
  `rememberTail()` helper, because cleanup only evicts jobs whose log it removed.
- The staging-suffix set is `STAGING_SUFFIXES = [".log", ".ec", ".fifo", ".cnt"]`.
- Two pre-existing issues surfaced while verifying: this worktree had drifted
  `@types/node` 26.4.1 (spec `^24.0.0`), which made the pristine base fail
  `tsc --noEmit` — fixed with `bun install --frozen-lockfile` (now 24.13.5), not
  by changing source. And the wake-stats test pinned `Stats: 0.0s` for an
  instant job; the capped wrapper spawns a few extra processes, so it is now
  asserted by shape (`/Stats: \d+\.\d+s, 1 lines/`) instead of pinning the host.
- Tests written: cap+notice+head-kept+exit-code, notice-excluded-from-stats and
  from last-line, exact-cap boundary, `0` = uncapped, no staging strays, stale
  staging reclaimed by the sweep (unrelated `.tmp-*` kept), bgtail/bggrep on a
  capped log plus the post-cap bytes being unsearchable, a multi-megabyte flood
  still exiting with its own code (no SIGPIPE), and `resolveConfig` normalization
  (blank env must not disable the cap).

Follow-on (added 2026-09-20, second pass): **truncation is agent-visible**, not
just on disk. The first pass filtered the notice out of every reader, which meant
nothing told the agent a log had been capped — and the shipped digest presets
(jest/pytest/go-test/junit-xml all read the log's END) would then report
`fail: 0` for a run whose failures were past the cap. Now:

- `parseTruncationFromContent()` (exact: the notice counts only when it is the
  line immediately before the exit marker) + `readTruncationBytes()` (decided
  from the standard 256 KB tail slice — no extra IO) + `formatBytes()`.
- The wake's Stats line gains `log truncated at 64 MiB`.
- A selected digest is **skipped** with an explanation instead of run.
- `bgtail`/`bggrep` append a labelled note and report `truncatedAtBytes` in
  their details (`bgtail` also on its delta early-return path).
- README + `skill/run-bg/SKILL.md` state the rule: on a capped job, a missing
  digest means "unknown", not "no failures".
- Context cost: zero for under-cap jobs; for capped jobs one extra clause in the
  Stats line and one note line per reader call (the alternative — a confidently
  wrong scorecard — costs more and misleads).

Follow-on (added 2026-09-20, third pass): **context economics vs context-mode**,
measured on a synthetic 1.29 MB / 20 000-line test log (raw ≈ 1.29 MB):

| path | context cost |
| --- | --- |
| raw dump | 1,287,215 chars |
| wake alone (exit, duration, lines, last line, digest, truncation) | ~200 chars |
| `bgtail` (last 40, condensed, 8 KB cap) | 2,600 chars |
| `bggrep` (failure regex, ≤50 matches) | 873 chars |
| `ctx_execute_file` equivalent | 744 chars stdout **+ 221 chars of code the model writes** |

Output envelopes are comparable, so the read tools do not win on bytes; they win
on zero-code calls, in-memory delta bookmarks (repeat polls ~free), job-id
resolution, a regex wall-clock budget, and no FTS5 side effects (`ctx_execute_file`
auto-indexes stdout >100 KB and switches to BM25 sections above 5 KB with `intent`).
The wake is the real saver — most jobs need no read at all.

Two defects found while checking, both fixed:

1. The claim that a "project-sandboxed `ctx_execute_file` cannot reach the global
   jobs dir" was **false** — its schema takes "absolute file path or relative to
   project root" and its only check is the agent's own Read-deny policy
   (`checkFilePathDenyPolicy`); there is no project-root confinement. Corrected in
   README (×3), `skill/run-bg/SKILL.md` (×2) and bggrep's tool description, and
   reframed: the real advantage is resolving the job id, not reach.
2. `bgtail`/`bggrep` read only the **last 2 MB** (`LOG_READ_BYTES`, one call site
   in `resolveLogForJob`) — with a 64 MiB ceiling that silently hides 97% of a
   capped log, and "— none" reads as "no failures anywhere". Both readers now
   append a window caveat when `size > LOG_READ_BYTES`, and the SKILL points at
   `ctx_execute_file` as the whole-file path (the only tool that covers >2 MB).

Third pass, part 2 — the window became an argument (this was the user's read on
defect 2, and it was right):

- **The two bounds are independent, which the first pass blurred.** `maxLogBytes`
  bounds bytes *written to disk* (inside the detached wrapper); `LOG_READ_BYTES`
  bounds bytes *scanned* by the readers (`resolveLogForJob`). The cap never
  bounded reads — past 2 MB the readers always saw a slice, and a legitimate
  64 MiB log made that slice 3% of the file.
- **`bytes` param on `bgtail` and `bggrep`**, clamped by `clampReadWindow()`:
  absent/garbage/≤0 → the 2 MiB default; wider than `LOG_READ_BYTES_MAX`
  (= `DEFAULT_MAX_LOG_BYTES`, since no job can have written more than the
  ceiling) → the ceiling. Both report `windowBytes` in details.
- **A wide window costs latency and memory, NOT context.** Only the scan grows;
  the returned text stays capped by the condenser (~8 KB, ≤50 matches). Asserted
  directly: an 8 MiB-window search over a 2.7 MB log finds a marker the default
  window misses while the result stays <9000 chars.
- **Bug caught while wiring it:** a changed window moves the window's *first*
  line, so the stale "log was replaced" heuristic fired first and mislabelled a
  widened read. `windowChanged` now beats `replaced`, and bgtail resets the delta
  with `search window changed since last read — showing full tail` instead of
  reporting pages of "new" lines that were merely never looked at.
- The window caveat now names the actual window and the escape hatch: `pass a
  larger 'bytes' (max 64 MiB) or use ctx_execute_file on the log path`.

Third pass, part 3 — **the machine-global jobs dir is deprecated** (user call,
docs-only, staged):

- Project-scoped logs are the model; `PI_BGRUN_GLOBAL_DIR` and the
  `~/.pi-bgrun/jobs` destination are marked deprecated in the README env table,
  the Roadmap, and the run-bg SKILL, with a new `### Deprecated: machine-global
  jobs dir` section (why project-scoped won, what is lost, 3-step migration).
- **Nothing breaks today:** existing absolute `jobsDir`/`PI_BGRUN_DIR` behave
  exactly as before; removal is reserved for a future major.
- **The fallback cannot be removed, only demoted:** a cwd with no project root
  still resolves to `~/.pi-bgrun/jobs` (`globalJobsDir()` at :733/:735). The
  alternative is scattering logs into an arbitrary cwd, which the code
  deliberately refuses. It becomes an undocumented internal fallback.
- **`PI_BGRUN_GLOBAL_DIR` is also the test seam** (`index.test.ts:75`, plus two
  more sites) for staying off the real `~/.pi-bgrun`, so "remove the knob" needs
  a HOME-override replacement in the same change.
- **No runtime deprecation warning, deliberately:** it would fire on every
  test-run config and cannot distinguish a test seam from a real user. Docs are
  the honest lever; add the warning on request.

Fourth pass — **Node leaves CI, and the seam stops being the deprecated knob**:

- **`bun pm pack --dry-run` is a real substitute** for `npm pack --dry-run` (it
  prints the packed file list and `Total files: N`), and `bunx`/`bun run lint`
  cover `npx tsc`. So every CI step ran on Bun already, with a Node toolchain
  installed for nothing. `ci.yml` is now **bun-only**: no `setup-node`, steps are
  `bun install --frozen-lockfile` / `bun run lint` / `bun test
  extension/index.test.ts` / `bun pm pack --dry-run` (guard re-pointed at Bun's
  `Total files:` casing). All four verified locally, including the tarball
  allowlist guard parsing 7 files and rejecting test-file patterns.
- **What dropping Node costs:** the V8/worker_threads side of bggrep's bounded
  matching is no longer exercised in CI. Bun *does* implement
  `node:worker_threads` (verified: `typeof Worker === "function"`), so the worker
  *mechanism* is still covered — only V8's backtracking behaviour is not. Manual
  insurance, recorded in a comment in `ci.yml`: `node --test
  extension/index.test.ts` passes **183/183 in ~16s** (run 2026-09-20, Node
  24.15). Re-run it by hand after touching the worker path.
- **`fold-in #3` is therefore resolved as "no Node job"**, not deferred.
- **The test seam no longer rides on the deprecated knob.** `PI_BGRUN_GLOBAL_DIR`
  was the only way to keep tests off the real `~/.pi-bgrun`, because **Bun's
  `os.homedir()` ignores `$HOME`** (verified: unchanged after mutating HOME in
  process) — the old-looking `homeDir()`-style comment in `resolveConfig` was the
  maintainers working around exactly that. Fix: a `homeDir()` helper that is
  HOME-first (`process.env.HOME || homedir()`), used by `globalJobsDir()`,
  `expandTilde()`, `findProjectRoot()` and the user-config path. Node already
  behaved this way, so this *aligns* the runtimes rather than inventing policy;
  the test file now pins `HOME` and leaves `PI_BGRUN_GLOBAL_DIR` unset, so
  retiring the knob is a docs+3-line delete instead of a test rewrite.
  Verified green under **both** runners (183/183 bun, 183/183 node).
- `PI_BGRUN_GLOBAL_DIR` stays *supported* (deprecated) — the deprecation is about
  the machine-global destination, not about this override, which is also the
  escape hatch for anyone who genuinely wants one shared dir.

Fifth pass — **the V8 concern, measured, and a vacuous test fixed**:

| engine | `^(a+)+$` over `"a"×n + "!"` | |
| --- | --- | --- |
| Node 24.15 (V8/Irregexp) | n=100 → **killed at 10s** | exponential backtracking |
| Bun 1.3.6 (JSC) | n=100…5000 → **~250ms, constant** | no backtracking blowup |

So the hazard the worker+budget exists for is real and *engine-specific*: on
JSC the pathological case effectively does not exist, which is why a Bun-only CI
cannot verify the guard by input. Two things follow:

1. **The shipped test was vacuous.** `bggrep: a pathological regex returns within
   the budget instead of hanging` wrote 60 000 "a"s plus a "b" — but bggrep
   pre-truncates each line to `BGGREP_LINE_CAP = 10 000` *before* matching, so
   the "b" was cut away and `^(a+)+$` matched in **0ms on both engines**. The
   failing character now sits inside the cap window: 2004ms on Node (budget
   trips, worker terminated), ~250ms on Bun.
2. **The abort path now has an engine-independent test.**
   `matchLinesWithBudget()` takes an injectable worker body (optional param,
   defaulting to `BGGREP_WORKER_SOURCE`) and is exported for tests, so a worker
   that never returns proves the budget ends it — ~300ms, on both engines.
   That is the assertion an input-driven pattern cannot make portably.

3. **The sync fallback is covered too.** `matchLinesSyncBounded` runs only where
   `node:worker_threads` is missing — never on Node or Bun — so nothing exercised
   it: a regression there would ship silently and surface as "bggrep behaves
   differently in that environment". Exported for tests (like the other seams)
   and covered by parity with the worker path (matches, misses, the per-line cap,
   a bad pattern's `invalid` outcome) plus both budget guards: fired before the
   first line when the budget is already spent, and re-checked mid-scan (0 ms
   budget over 300 000 lines aborts rather than finishing the corpus).

Sixth pass — **publishing stays on npm** (asked: any downside to `bun publish`?).
`bun publish` has no OIDC trusted-publishing and no provenance support (auth is a
long-lived `NPM_CONFIG_TOKEN`; the documented flags carry no provenance option),
while `release.yml` relies on `id-token: write`, stores **no** token, and gets
provenance attestations for free from trusted publishing. Switching would trade a
tokenless, attested release for a stored bearer credential — so the release path
keeps Node+npm deliberately, unlike the test job, and a comment next to the Node
setup says why. Functional parity was *not* the issue: `--access`, `--tag`,
`--dry-run`, `--otp` and registry config all exist in Bun, lifecycle-script
differences are moot (no `prepack`/`prepublishOnly`/`prepare` here), and
`--tolerate-republish` is actually nicer than npm for CI re-runs.

Consequence for the CI decision: `bun test` now covers the worker *mechanism*
deterministically (abort path + budget plumbing + the fixed stress input) and
the fallback's contract, and `node --test` remains the only way to exercise V8's
own backtracking — a manual command, noted in `ci.yml`. Suite: 186/186 under
both runners.

## Problem

`bgrun` redirects the child's stdout+stderr straight to the log fd
(`spawn("sh", ["-c", wrapper, "bgrun", command], { stdio: ["ignore", logFd, logFd], detached: true })`,
`extension/index.ts` ~:1765). The read side is bounded on this base
(`readLogSlice()` @:221 — `LOG_TAIL_BYTES = 256 KB` for the exit marker,
`LOG_READ_BYTES = 2 MB` for `bgtail`/`bggrep`), but the **write side is
unbounded**: a runaway job (`yes`, a spew loop, a pathological build) fills the
disk and can take the machine down. Secondary effect: `countLogLines` (:1134)
streams the whole file at exit (bounded memory, unbounded IO).

## Constraints (any fix must respect these)

1. The cap must live **inside the detached process tree** — pi can exit at any
   time. No parent-side streaming (that would break "survives pi crashing").
2. The `__BGRUN_EXIT__` marker must remain the **last non-empty line** —
   `parseExitFromContent` (:256) walks backwards to the last non-blank line and
   treats only that as completion evidence (a marker that is not last is job
   output that happens to contain the string). `readLogSlice(LOG_TAIL_BYTES)`
   finds it as long as it stays in the final 256 KB — which a head cap
   guarantees, since the whole capped log is ≤ CAP + overhead.
3. One writer, one offset — two writers into the same file corrupt it (this
   includes the exit-code file; see below).
4. Cap only the redirected stdout/stderr, **never the command's own files**.
5. `maxLogBytes: 0` means unlimited and MUST produce the **current** wrapper
   verbatim. It must not be routed through the capped pipeline.

## Chosen design: Option A — in-tree head cap, job survives

Replace the current wrapper:

```sh
sh -c "$1"; ec=$?; printf '\n__BGRUN_EXIT__%d\n' "$ec"; exit "$ec"
```

with a capped pipeline plus an exact byte counter:

```sh
# argv: $1 = command, $2 = ecfile, $3 = cap, $4 = fifo, $5 = countfile
count="$5"; rm -f "$4" "$count"; mkfifo "$4"; ( wc -c <"$4" >"$count" ) & ctr=$!
{ sh -c "$1" 2>&1; ec=$?; printf '%d' "$ec" >"$2"; } \
  | tee "$4" | { head -c "$3"; cat >/dev/null; }
wait "$ctr"
total=$(cat "$count"); ec=$(cat "$2")
rm -f "$2" "$4" "$count"
if [ "${total:-0}" -gt "$3" ]; then
  printf '\n[pi-bgrun] output truncated at %s bytes (first %s bytes kept)\n' \
    "$3" "$3"
fi
printf '\n__BGRUN_EXIT__%d\n' "$ec"; exit "$ec"
```

(The notice literal above is generated from `TRUNC_NOTICE_PREFIX`; it is a
constant, so it is safe to interpolate into the wrapper's format string.)

Why this shape:

- `head -c CAP` writes the first CAP bytes to the wrapper's stdout (the log fd).
- `cat >/dev/null` then drains the rest, so the producer never gets SIGPIPE and
  the **job runs to completion** with its real exit code (unlike Option B).
- `tee "$fifo"` runs a *second*, uncapped copy of the stream into `wc -c`, so
  the wrapper knows the true total. `total > CAP` is the truncation test.
- The command's exit status is captured to `$2` *by the producer group*
  (redirected to a file, not the pipe), because a pipeline's `$?` is the
  reader's. The wrapper reads `$2` and prints the marker. Constraint 3 holds:
  only the producer writes `$2`, only `wc` writes `$5`.
- Single writer at a time into the log: the reader stage writes to fd1, then the
  wrapper's `printf` writes to the same fd1 — same offset, no corruption.
- Works with pi dead: the whole thing is inside the detached tree.

Accepted price: the log keeps the **first** CAP bytes, not the tail. There is no
portable in-tree *tail* cap — a ring buffer needs a helper binary, and a circular
file breaks every existing reader (marker-at-tail, `bgtail`, `bggrep`). A job
that emits > CAP is almost always a runaway, so the head is the useful part.

### Truncation detection: why not the simple counters

Measured on this machine (macOS 25.6, BSD `head`) while writing this brief:

| detection idea | result |
| --- | --- |
| count bytes left after `head -c CAP` (`cat \| wc -c`) | **silently 0** whenever the overshoot is smaller than `head`'s read buffer: `CAP=100 N=101` → 0, `CAP=1000 N=1500` → 0, `CAP=8192 N=8193` → 0; only `CAP=65536 N=65537` → 1. `head` over-reads into its buffer and discards the excess. |
| `wc -c </dev/fd/1` (size the log fd) | **fails** — the log fd is opened `O_WRONLY`, so the reopen gets `Permission denied`. |
| fifo + `wc -c` on the tee'd full stream | **exact** in all four cases above. |

The fifo shape was prototyped end-to-end against the real log-fd setup and
verified: cap held (1000 → 1017 bytes = cap + marker), exit codes 7 and 0
preserved, marker last, no leftover fifo/counter/ec file.

If a fifo is judged too clever for this codebase, the equivalent is to spawn
`process.execPath` as the reader (exact count, no coreutils/BSD variance) — but
that is a larger change to the spawn path and adds a runtime dependency; the fifo
uses only POSIX `sh` + `mkfifo` + `tee` + `wc`.

## Truncation must be visible

Before printing the exit marker, if `total > cap`, append:

```
[pi-bgrun] output truncated at <CAP> bytes (first <CAP> bytes kept)
```

Details that matter:

- **Leading `\n` is required.** Without it the notice glues onto the truncated
  last byte (`…aaa[pi-bgrun] output truncated…`), which corrupts line counts and
  `bggrep` line numbers. Verified in the prototype.
- Define one constant (`TRUNC_NOTICE_PREFIX = "[pi-bgrun] output truncated"`) and
  filter it wherever `EXIT_MARKER` is filtered today: `countLogLines`' tail
  accounting ("N lines" must not count the notice) and the wake's last-line
  pick. Otherwise the wake reports the notice as the job's last output.
- `bggrep` will match the notice if the caller greps that phrase (e.g. grepping
  a bgrun log for `truncated`). That is acceptable and should be documented in
  `skill/run-bg/SKILL.md` rather than worked around.

## Config + env

- New config field `maxLogBytes` (number, bytes), plus `PI_BGRUN_MAX_LOG_BYTES`.
- Default **64 MiB**. `0` = unlimited (documented escape hatch) → take the
  legacy uncapped wrapper path, no fifo, no reader.
- Read at spawn time (per-job), so a config edit affects the next job only.
- Validate like the other numeric fields: finite, integer, `>= 0`; reject `NaN`
  / negative / non-number to the default.

## Files / plumbing

- `extension/index.ts`:
  - config field + normalization + env merge (next to `cleanupDays`, :950-1003).
  - wrapper construction + spawn argv in the `bgrun` tool `execute` (~:1750).
    The wrapper already receives `command` as `$1`; add `$2` ecfile, `$3` cap,
    `$4` fifo, `$5` countfile.
  - `TRUNC_NOTICE_PREFIX`, and the marker-filtering updates in
    `countLogLines` (:1134) and the last-line pick.
  - help/description text.
- Staging artifacts, next to the log in the jobs dir (same convention as the
  existing `.tmp-<slug>-<ts>-<hex>.log`): `.tmp-<slug>-<ts>-<hex>.ec`,
  `…fifo`, `…cnt`. The jobs dir is guaranteed writable (the log fd already lives
  there), unlike `TMPDIR`.
- **Widen the sweep predicate.** `sweepStaleMarkers` (:1220) currently reclaims
  only `.tmp-*` names ending in `.log`; the new `.ec`/`.fifo`/`.cnt` strays
  (left only by a hard kill) would never be reclaimed. Match
  `.tmp-*.(log|ec|fifo|cnt)`. Do **not** rename the ec file to `.log` to reuse
  the existing predicate: `.log`-suffixed files are treated as job logs by
  `adoptForeignJobs` / `cleanOldJobs` / `bgstatus`, and the `.tmp-` skip exists
  only in one function (:346).
- In the normal path the wrapper removes its own artifacts (verified); the sweep
  is for kill -9 / power loss only.
- `README.md`: env-table row + a short "Log size ceiling" note (state the
  head-cap tradeoff explicitly).
- `skill/run-bg/SKILL.md`: one line so the agent knows logs can be truncated and
  the notice line is not command output.

## Tests

The list below is the acceptance sketch from planning. What actually shipped is
these 18 tests (the earlier 165 are unchanged and pass against the capped
wrapper, which is the transparency check for bgtail/bggrep/digest/adopt):

| # | Test |
| --- | --- |
| 1 | maxLogBytes keeps the first N bytes, notes the truncation, preserves the exit code |
| 2 | the truncation notice is not job output — not counted, not the last line |
| 3 | a job that outruns the cap by megabytes still finishes with its own exit code (no SIGPIPE) |
| 4 | a log at exactly the cap is not called truncated; one byte over is |
| 5 | maxLogBytes 0 leaves the log uncapped |
| 6 | a capped job leaves no staging files behind |
| 7 | stale staging files (.ec/.fifo/.cnt) are reclaimed; unrelated `.tmp-*` are not |
| 8 | bgtail/bggrep work on a capped log and only see what was kept |
| 9 | resolveConfig: maxLogBytes accepts 0 and ignores blank/invalid values |
| 10 | formatBytes / parseTruncationFromContent: the notice counts only as the wrapper's own line |
| 11 | wake: a capped job says so in the Stats line; an uncapped one does not |
| 12 | wake digest: a scorecard is skipped, not misreported, when the log was capped |
| 13 | bgtail/bggrep: a capped log is labelled and carries truncatedAtBytes |
| 14 | bgtail/bggrep: no truncation label on an uncapped log |
| 15 | a log bigger than the 2 MB read window says it was only partly searched |
| 16 | no window caveat on a small log |
| 17 | `bytes` widens the search window without widening the output |
| 18 | clampReadWindow: default, explicit, garbage, and ceiling |

Original sketch below.

1. Generator > CAP → log size is exactly `CAP + notice + marker + leading
   newlines` (not merely "≤ CAP + overhead" — pin the real ceiling), marker
   present and last, exit code correct.
2. Truncation notice present when capped; absent when under; **exact-CAP output
   is not reported as truncated** (boundary).
3. Exit code preserved exactly (0 and non-zero) through the pipeline.
4. Notice is not counted by `countLogLines` and is not the wake's last line.
5. `bgtail`/`bggrep` on a capped log: content returned, marker found, and
   `readLogSlice`'s `truncated: true` (tail window < file) is asserted as a
   *distinct* signal from the cap notice — do not conflate them.
6. `maxLogBytes: 0` disables the cap (full output written, no notice, no fifo
   created, legacy wrapper path used).
7. `$ecfile`/fifo/countfile removed after use (no stray `.tmp-*` beyond the
   log); a simulated stale one is reclaimed by `sweepStaleMarkers`.
8. Existing behavior unchanged: pipes, `&&`, `#`, quotes, heredoc commands.
9. Notice has a leading newline — assert the byte before the notice is `\n`.

## Rejected alternatives

- **C — pi-side watchdog** (stat running logs, kill + truncate tail): soft bound
  only while pi lives; overshoot = write-rate × poll interval; unbounded if pi
  died. Keeps the tail, but doesn't keep the promise.
- **B — `head -c` without the `cat` drain**: producer dies on SIGPIPE (141);
  hostile to legitimately verbose builds.
- **D — `ulimit -f`**: caps *every* file the job writes (artifacts, downloads)
  and kills it (SIGXFSZ/153). Opt-in only, not a default.
- **E — document + trim finished logs**: no bound while running.
- **F — `dd bs=1 count=CAP`** as an exact front stage: no over-read, but one
  read syscall per byte (64 MiB cap = 64M syscalls) — unusable.

Revisit C only if tail retention turns out to matter in practice.

Estimate: ~2.5–3 h including tests and the two fold-ins below (the earlier ~1.5 h
estimate predated the detector rework, the `0` branch, and reconciliation with
PR #11 — the rebase itself is now done).

## Fold-in follow-ups (from the 2026-09 adversarial review)

**Status (2026-09-20): both closed, see the seventh pass.**
**#1** closed — `countLogLines` now takes the tail offset from `fstatSync(fd).size`
and refuses (returns `null`) when the file exceeds `readWindowMax()`, so the scan
is bounded and the tail pread can never be misplaced by a bound.
**#2** closed — the map is evicted on log removal (`cleanOldJobs`,
`cleanSessionJobs`) *and* hard-capped by `TAIL_BOOKMARK_CAP` with
oldest-insertion eviction, so it cannot grow unboundedly even without cleanup.
**#3** resolved as "no Node job" (fourth pass, fourth bullet), not deferred.

Both were found on the review branch (`lloydsk/Feedback-Improvements`, PR #11)
and deliberately deferred here, because a log size ceiling is the proper fix for
both — do them as part of this work, not separately. Re-verified against
`8cba8d9`: both were still open.

### 1. `countLogLines` streams the whole file at exit (`extension/index.ts` :1134)

On a job's `exit`, `countLogLines` reads the **entire** log in 64 KB chunks on
the main thread, just to report an `N lines` stat in the wake. With the cap in
place the file is bounded at 64 MiB — that is still a synchronous full-file read
per job exit, so the byte bound here is **required**, not defence in depth.

Add a hard read bound (e.g. 64 MiB, or `maxLogBytes` when non-zero) and add
`fstatSync` for the tail offset: the current code derives the 512-byte pread
offset from `size` accumulated while streaming, so a *capped* `size` would seek to
the wrong place and drop the exit marker from the line-count accounting. Seek by
the real `fstatSync(fd).size` instead.

### 2. `tailBookmarks` grows unboundedly (`extension/index.ts` :2255)

`bgtail`'s delta-tailing bookmarks map gains one entry per distinct job id ever
tailed and is never evicted — confirmed: the map has only `.get`/`.set`, no
`.delete`/`.clear` anywhere. A slow leak over a long session.

Evict entries in `cleanSessionJobs` (:1305) / `cleanOldJobs` (:1246) when the job's
log is removed, and/or cap the map (drop the oldest insertion) so it cannot grow
without bound.

### 3. (context) CI runs tests on Bun only

`.github/workflows/ci.yml` runs `npm test` → `bun test extension/index.test.ts`,
so the Node/V8 worker + regex path (:90-161) — the reason `bggrep`'s worker
bound exists — is never exercised in CI. If the ceiling work adds a
self-terminating output generator test, a Node smoke job is cheap to add then.
Not required for this feature.

Seventh pass — **adversarial-review round: ten defects fixed, each pinned by a test** (2026-09-20):

Every item below was reproduced before it was fixed; the test named with each is
the regression guard. Measured, not asserted: with this round's test file run
against the pre-round source (the committed `tee | head -c | cat` shape,
`e7f0669`), **14 tests fail** — every ceiling assertion re-pinned here, plus the
backgrounded-child test timing out at 4 s, which *is* the pre-fix hang.

1. **A ceiling literal that `sh` cannot parse emptied the log.** `1e21` (and any
   value above `Number.MAX_SAFE_INTEGER`) reached the wrapper as `head -c 1e+21`,
   which errors and writes nothing — output discarded, not merely uncapped. Likewise a
   *fractional* ceiling (`0.5`) truncated to `0`, and `0` means unlimited, so the cap
   silently vanished. Fix: normalize to an integer in `1 … MAX_SAFE_INTEGER` before it
   is ever interpolated into the shell.
   Tests: *a ceiling above Number.MAX_SAFE_INTEGER still logs the output*, *a fractional
   ceiling caps instead of silently meaning unlimited*.
2. **`mkfifo` failure ran uncapped and silently.** The fallback path now prints a
   `[pi-bgrun] log ceiling unavailable …` notice and sets the marker's `nocap` flag, so
   "the ceiling could not be installed" is never indistinguishable from "output was that
   small". Test: *formatBytes / parseCapStatus: the cap comes from the marker, never
   from printable text*.
3. **Truncation detection was inferable from printable text.** Earlier shapes asked the
   log itself (`wc -l`, a sentinel line), so a command that printed a line resembling
   the notice could fake a capped log — and a `head -c` + drain shape could not tell
   "exactly at the cap" from "still writing" without a race. Fix: the writer's own
   out-of-band state — a fifo drain that reports the byte budget and truncation, and the
   flag carried in the exit marker's own line. Test: *a command that prints the notice
   cannot make its log look capped*.
4. **A backgrounded child held the job open.** As a pipeline stage the wrapper waited for
   pipe EOF, so a command that backgrounded a child and exited (`sleep 30 & echo done`)
   produced **no wake for 30s — or never, for a daemon**; the job reported completion
   after the stray. Fix: `wait` on the command's own pid, then a short bounded grace for
   the drain, so completion follows the command, and output from a stray that outlives it
   simply stops being logged. Test: *a backgrounded child does not hold the job open*.
5. **Fold-in #1** (`countLogLines`): resolved, see the fold-in section above.
6. **Fold-in #2** (`tailBookmarks`): resolved, see the fold-in section above.
7. **The widest window could not cover a capped log.** `bytes` was clamped to the ceiling
   itself, but a capped log is always *larger* than the cap (notices + marker), so the
   documented "widen it to the whole capped log" was never actually reachable. Fix:
   `readWindowMax()` = ceiling + 4 KiB. Test: *readWindowMax: the widest search window
   can cover a log the ceiling produced*.
8. **A window could be materialized line-by-line without bound.** Byte-bounding a window
   is not enough when the lines are tiny: 64 MiB of one-character lines is ~33 M line
   strings, measured at >3 GB of RSS — an OOM on exactly the log class the ceiling exists
   for. Fix: `LOG_SCAN_LINES_MAX = 500_000` (~40 MB), with a labelled note ("only the
   last N lines of that window were searched") so a trimmed window is never reported as a
   plain "none". Test: *bgtail/bggrep: a window of very short lines is scan-bounded, and
   says so*.
9. **Staging files outlived the sweep.** The sweep reclaimed marker files only, so a job
   that died before its wrapper's `rm -f` left `.tmp-*.(log|ec|fifo|pid|trunc)` behind
   forever — while sweeping them on mtime alone would delete a *running* job's staged
   fifo out from under it. Fix: sweep by mtime **and** skip any stem whose `.pid` belongs
   to a live process. Tests: *bgclean: stale staging files (.ec/.fifo/.pid/.trunc) are
   reclaimed, unrelated .tmp-* are not*, *bgclean: a running job's staging files survive
   an aggressive sweep*.
10. **The CI allowlist guard could pass without checking anything.** A failing
    `bun pm pack` printed `? files` and the step stayed green (the later greps cannot fail
    on an empty listing), so a broken tarball could ship with a green check. Fix: an
    explicit `pack_status`/file-count guard. Separately, the packer under test changed to
    **npm**: `release.yml` publishes with `npm publish` (OIDC trusted publishing), so the
    allowlist must be checked against the packer that actually builds the shipped tarball.
    Both packers emit the identical 7 files today, and that agreement is the check's
    purpose. npm is preinstalled on the runner — no second toolchain.

**Drift corrections to earlier passes:** the staging-suffix set is
`[".log", ".ec", ".fifo", ".pid", ".trunc"]` (not `.cnt`), and the wrapper's argv is
`$1` command, `$2` ecfile, `$3` fifo, `$4` pidfile, `$5` truncation-flag file. The
`tee`-into-`wc -c` prototype in the design section was replaced by the single copier
(perl first, then `dd`, then `head`) that caps, flags, and drains in one process.

**Verified (2026-09-20):** 193/193 pass under both runners — `bun test
extension/index.test.ts` and `node --test extension/index.test.ts` (Node 24.15, ~20s),
`tsc --noEmit` clean, `npm pack --dry-run` guard exercised locally, `actionlint` clean.
