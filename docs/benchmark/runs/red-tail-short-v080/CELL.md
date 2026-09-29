# Cell 1c — `red-tail-short` on the current tool (0.8.0), 2026-09-29

The same cell as [Cell 1](../red-tail-short/CELL.md) and [Cell 1b](../red-tail-short-fixed/CELL.md),
run again on the current tool: the same fixture (sha `0bfe00ed1d9866b9`), model, neutral prompt,
command and interleaving, with the only difference the tool code. This is the first run of this cell
that carries **both** the poll fix and the wake's closing-line change, so it is the current tool's
measurement and leads the `red-tail-short` section.

| field | value |
|---|---|
| model | `anthropic/claude-sonnet-4-6` |
| fixture | `/private/tmp/red-tail-fixture` — 2 files, 8 tests, fails at part 02 step 04, exit 1; `DUMMY_SLEEP_MS=1`, `DUMMY_ANNOUNCE_FAILURE=0` |
| prompt | the neutral prompt in the run sheet, unmodified: `Run bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/red-tail-fixture in this repo and report the failure details.` |
| revision under test | version **0.8.0** — `origin/main` at `9350fae` (release 0.8.0). The bench checkout stood at `fba9707`, its merge of that revision into the bench branch (that merge is on `origin/bench/dogfooding`, not `origin/main`). |
| in the tool | the no-poll change **and** the wake's closing-line change — both merged into `origin/main` as `6b04d24` and released as 0.8.0 |
| transcripts | `sessions/<arm>-<n>/`; session ids are in [profile.csv](profile.csv) |
| profile | [profile.txt](profile.txt), [profile.csv](profile.csv), [wake-claims.csv](wake-claims.csv) |
| before | [Cell 1b](../red-tail-short-fixed/CELL.md) (post-poll-fix, pre-framing) and [Cell 1](../red-tail-short/CELL.md) (pre-poll-fix) |

## Result

| # | arm | execs | fg | handoff | wall_s | blocked_s | idle_s | ctx_chars | diag | locate | cause | calls |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bgrun-1 | bgrun | 1 | 0 | 1 | 50.7 | 0.0 | 50.7 | 16,534 | up+down | pattern | reached | 4 |
| bgrun-2 | bgrun | 1 | 0 | 1 | 46.7 | 0.0 | 46.7 | 13,941 | up+down | pattern | reached | 3 |
| bgrun-3 | bgrun | 1 | 0 | 1 | 40.3 | 0.0 | 40.3 | 12,876 | up+down | pattern | reached | 3 |
| vanilla-1 | vanilla | 1 | 1 | 0 | 38.6 | 24.3 | 14.4 | 30,183 | up+down | position | reached | 1 |
| vanilla-2 | vanilla | 1 | 1 | 0 | 35.0 | 24.4 | 10.6 | 29,962 | up+down | position | reached | 1 |
| vanilla-3 | vanilla | 1 | 1 | 0 | 34.4 | 23.9 | 10.4 | 30,056 | up+down | position | reached | 1 |

Median `[min–max]` per arm:

| metric | bgrun | vanilla |
|---|---|---|
| wall_s | 46.7 [40.3–50.7] | 35.0 [34.4–38.6] |
| blocked_s | 0.0 [0.0–0.0] | 24.3 [23.9–24.4] |
| idle_s | 46.7 [40.3–50.7] | 10.6 [10.4–14.4] |
| ctx_chars | 13,941 [12,876–16,534] | 30,056 [29,962–30,183] |
| calls | 4, 3, 3 | 1, 1, 1 |
| execs | 1.0 [1.0–1.0] | 1.0 [1.0–1.0] |
| diag_reach / cause_reached | 3/3 | 3/3 |

All numbers above are `profile.csv` columns; the summary rows are reproduced in `profile.txt`.

## Where this run sits in the cell's history

| metric | Cell 1 (pre-poll-fix) | Cell 1b (post-poll-fix, pre-framing) | Cell 1c (current, 0.8.0) | vanilla |
|---|---|---|---|---|
| wake claims before exit | 1, 2, 1 | **0, 0, 0** | **0, 0, 0** | — |
| polls before exit | 10, 9, 5 | **0, 0, 0** | **0, 0, 0** | — |
| tool calls per session | 12, 11, 9 | 2, 2, 2 | **4, 3, 3** | 1 |
| `ctx_chars` (median) | 31,170 | 9,892 | 13,941 | 30,056 |
| `wall_s` (median [min–max]) | 45.4 [42.9–51.1] | 40.9 [38.1–42.7] | 46.7 [40.3–50.7] | 35.0 [34.4–38.6] |
| `blocked_s` (mechanism) | 0.0 | 0.0 | 0.0 | 24.3 |

Sources: `../red-tail-short/profile.csv`, `../red-tail-short-fixed/profile.csv` and this cell's
`profile.csv`; the claim and poll columns are `wake-claims.csv` beside each record
(Cell 1's is `../red-tail-short-fixed/wake-claims-before.csv`).

The poll fix holds on the current tool: **no session polled a running job and none claimed a wake
before receiving one** (`wake-claims.csv`: `claims_before_exit` 0, 0, 0 and `polls` 10, 9, 5 → 0, 0,
0; the one `calls_before_exit` per session is the `bgrun` call that starts the job). The framing
change then cost what the `trace-root` pair ([Cell 3](../trace-root/CELL.md) →
[Cell 3a](../trace-root-framewake/CELL.md)) showed it costs: **calls 2 → 3–4 and context 9,892 →
13,941**, because with the wake's closing line pointing at the log the session opens a window on it
instead of answering from the summary. The extra call is `bgtail` in all three sessions.

## What each arm actually did (from the transcripts)

**bgrun — hand off, wait for the wake, then search and read one window.** Every session ran the
same opening: a `bgrun` call, a short "handed off" line, then the wake. bgrun-2's opening line reads
*"Handed off to the background. I'll report the failure details when the run completes."*; bgrun-3's
reads *"Handed off to the background — the wake will arrive with the results."* The extension's own
`bgrun-job` record gives the job at ~24.4s in each session (bgrun-1 15:44:58.981→15:45:23.439,
bgrun-2 15:48:18.721→15:48:43.101, bgrun-3 15:53:06.234→15:53:30.618), and the wake arrives within
milliseconds of the exit. After it, all three sessions move straight to the log:

- **bgrun-2** — `bgrun` → `bggrep` → `bgtail`: its thinking reads *"Let me look at the test failures
  by searching the log for failure patterns."*, then *"The grep results don't show clear failures.
  Let me look at the tail of the log to see the summary of failures."*
- **bgrun-3** — `bgrun` → `bggrep` → `bgtail`: *"Let me look at the test failures in the log."*,
  then *"The output doesn't show any obvious failures. Let me look for specific failure markers…"*
- **bgrun-1** — `bgrun` → `bggrep` → `bggrep` → `bgtail` (the one four-call session): *"Let me look
  at the test failures in the log."*, then *"I see lots of passes but the failures are cut off. Let
  me search more specifically for the failing tests."*, then a `bgtail` of 70 lines.

No session used `bgstatus`, and no session read the log before the wake — there is no poll in any of
the three sequences.

**vanilla — one foreground call.** Each vanilla session ran the suite once, blocked ~24s on it, and
read the whole result in a single call: vanilla-1's thinking is *"Let me run the tests as
requested."*, vanilla-2's *"Let me run the bun test command in the current working directory."*, and
each then summarised the same failure. All three located by `position` rather than `pattern` because
the whole output arrived inline, so no windowing decision was made.

## Revision and repo-suite margin (issue #40)

The cell's command runs the repo's own suite **plus** the fixture. On this revision the command's own
output reads **`Ran 280 tests across 5 files`** — the 3 repo files plus the fixture's 2 — from the
wake digest (bgrun) and the foreground result (vanilla) alike. Captured before the run, the repo
suite alone was **272 tests across 3 files**. That repo-suite share is not pinned by the fixture
contract and grows as tests are added, so the absolute figures belong to this revision; the mechanism
findings do not depend on it. Tracked as
[#40](https://github.com/stablekernel/pi-background-run/issues/40).

## Verdict

- **H12 stays fixed on the current tool.** 0 of 3 sessions claimed a wake before receiving it, and
  the polls the claim used to license are still 0, 0, 0. The interaction is `bgrun` → yield → wake →
  one search → one window → answer.
- **Context is still below vanilla's**, but by less than Cell 1b: 13,941 against 30,056 (Cell 1b was
  9,892 against 28,021). The framing change added a read of the window, which is the same increment
  Cell 3a measured.
- **Wall stays negative**, as the floor argument predicted for a short job: the job is ~24.4s and the
  arm pays it plus the wake and its own turns, against vanilla's 24.3s of blocking; 46.7s against
  35.0s here.
- **No regressions:** `blocked_s` 0.0, `diag_reach` 3/3, `cause_reached` 3/3, `execs` 1 in every
  session.
- **n=3, one model, one fixture.** The effect is uniform across the three sessions, but three
  sessions demonstrate; they do not generalise.

## Instrument note

`sessions/` holds the six transcripts, checked in and sanitized in place by
`scripts/sanitize-transcripts.ts` (length-preserving, so no number moves; `--check` reports the tree
clean). `profile.txt` and `profile.csv` were regenerated from them so the rows cite the in-repo
paths; the numeric columns are identical to the profiler output captured at run time in
`.bench-runs/red-tail-short-v080/`. Cell 1/1b recorded two pre-existing noise sources in this cell's
combined run (a `NotImplementedError` from running `node:test` files under Bun, bun#5090, and an
occasional wake-timeout flake in the extension's own bgtail-cap test); neither appears in these six
transcripts, and both would be identical for the two arms regardless.
