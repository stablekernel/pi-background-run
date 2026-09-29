# bgrun at a glance

`bgrun` hands a long shell command to a background job: the session stays unblocked, the
command's output never enters the conversation, and the session is woken when the job finishes.
Its cost is that **wake** — the session still waits for the completion notification, then does
its own work around it before it can answer. What it buys is a session that never blocks:
`blocked_s` is 0.0 in every cell, against 22.8–660.2s of foreground waiting. Whether the trade
pays off turns entirely on **how long the job runs** — at ~23–34s the wake's round trip costs
more than it saves, at ~204s the background arm pays the job once while the synchronous arm pays
it over and over. Below: one section per measured cell, the three-way pointer result, then where
it does not help. Every figure cites the cell's `profile.csv`; the full case and limits are in
[`BENCHMARK.md`](../../BENCHMARK.md).

## Where to start

**This document covers the current tool only.** Superseded runs — the tool's history, and the
before-half of every check below — are in [`BENCHMARK.md`](../../BENCHMARK.md) and
[`results.md`](results.md), not here. Most readers only need route 1; the rest is for checking
the work.

1. **Five minutes — this file, then stop.** Every finding and number for the current tool is
   here; the terms are in the [Glossary](#glossary), the caveats under [Limits](#limits).
2. **The findings and their limits** — [`BENCHMARK.md`](../../BENCHMARK.md): the full case, the
   argument behind it, what the measurements do and do not support, and the history.
3. **How it was measured, and re-deriving it** — [`method.md`](method.md) (procedure and the rules
   these records follow), [`results.md`](results.md) (every cell, each outcome, and the earlier
   generations), [`predictions.md`](predictions.md) (the hypotheses `H1`–`H12`), [`runs/`](runs/)
   (transcripts, profiles, per-cell sheets). Re-check a figure with
   `bun scripts/measure-sessions.ts <session dirs> --csv` (`method.md` § *Re-deriving a table*).

Running a cell is operator work, not reading: that run-book — the quickstart for
`./run-cell.sh <cell>` — is in [`method.md`](method.md#procedure) § Procedure
(issue [#39](https://github.com/stablekernel/pi-background-run/issues/39)).

Cells: [`red-tail-short`](#red-tail-short--failure-near-the-end-of-a-short-run) ·
[`long-buried`](#long-buried--a-failure-buried-in-a-long-noisy-run) ·
[`trace-root`](#trace-root--symptom-at-the-end-cause-three-frames-down-another-file) ·
[pointer variants](#the-three-way-pointer-result)

## `red-tail-short` — failure near the end of a short run

**What it tested.** The repo's own suite plus a fixture that fails near the end of the output: a
short run whose diagnostic is one tail-window away. Does the handoff buy anything when the failure
is cheap to reach?

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 46.7 [40.3–50.7] | **35.0** [34.4–38.6] |
| `ctx_chars` | **13,941** [12,876–16,534] | 30,056 [29,962–30,183] |
| `calls` | 4, 3, 3 | 1 [1–1] |
| `blocked_s` (mechanism) | 0.0 | 24.3 |

Source: `runs/red-tail-short-v080/profile.csv` (summary rows). The interaction is `bgrun` → yield
→ wake → search → one window → answer: two sessions ran `bgrun bggrep bgtail`, the third
(`bgrun-1`) added a second `bggrep`. No session polled a running job or claimed a wake it had not
received (`wake-claims.csv`: `claims_before_exit` 0, 0, 0 and polls 0, 0, 0) — which is why
`blocked_s` 0.0 carries no hidden polling; the fabricated-wake episode that check exists for is in
[`BENCHMARK.md`](../../BENCHMARK.md) § Robustness. Wall stays negative, as the floor argument
predicts for a ~24.4s job: 46.7s against 35.0s.

## `long-buried` — a failure buried in a long noisy run

**What it tested.** Ten fixture parts with the failure in `part-05` (the only part with a real
assertion cluster), so a tail read has nothing to find: 570 tests, 1,281 lines, ~204s per run.
This is the regime the async handoff is *for*. Run with no digest configured, so the pointer layer
is not exercised.

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | **225.9** [223.1–228.4] | 696.2 [283.8–732.4] |
| `blocked_s` (mechanism) | **0.0** | 660.2 |
| `ctx_chars` | **18,760** [16,365–21,056] | 79,901 [66,792–86,836] |
| `calls` | 3, 4, 4 | 12, 2, 6 |
| cause reached (`part-05.test.ts`) | 3/3 | 3/3 |

Source: `runs/long-buried/profile.csv` (summary rows). The first cell where bgrun wins on both
axes — 3.1× faster and 4.3× lighter — with the diagnosis a tie. bgrun paid the ~204s job once
(median session 225.9s ≈ the job plus ~22s of agent work; bgrun-1 made two `bggrep` calls and
stopped, bgrun-3 added a `bgtail` for context); vanilla paid it repeatedly (vanilla-2 ran the whole
suite twice, the second wait 203.6s and 86,836 characters by the end; vanilla-1 made 12 calls
across 8 foreground runs). Both arms reached `part-05.test.ts:59`; bgrun bought the same answer at
a quarter of the context because vanilla bought it by reading everything.

## `trace-root` — symptom at the end, cause three frames down another file

**What it tested.** The failure's *cause* lives in a file of its own (`harness.ts`), reachable
through a stack frame the failure's own wording never mentions. Symptom cheap to find; cause one
frame down. The wake's closing line is language-neutral — *"a summary, not the diagnosis — the log
holds the detail… read a window around the failure before concluding a cause."* — so nothing in
the wake promises the summary is the answer.

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 40.7 [39.2–43.9] | **34.5** [33.2–34.6] |
| `ctx_chars` | **14,009** [13,559–16,243] | 29,721 [29,610–29,731] |
| `calls` | 3 | 1 |
| `harness.ts` in context | **3, 3, 5** | — |
| deepest frame seen | **`harness.ts`** | `harness.ts` |

Source: `runs/trace-root-framewake/profile.csv` (summary rows) and
`runs/trace-root-framewake/CELL.md`. Vanilla's own run is unmoved (single full read). The sequence
is `bgrun` → `bggrep` → one more read — `bgtail` in two sessions (bgrun-1, bgrun-3), a second
`bggrep` in the other — to reach the window where the frames sit. bgrun-1's answer names the
harness: *"**Harness:** …/harness.ts:28"*. The extra call cost ~4k characters and bought the cause,
still at half vanilla's context: the wake's plain instruction — *read a window around the failure* —
knows nothing about how any runner spells a stack frame, yet it is enough to send the session to the
window where the frames sit.

## The three-way pointer result

The `on: "failure"` gate and the trace presets put a *pointer* — a named failing test and its source
frame — into the wake. Cell 4 (`long-buried`) ran that layer three ways, each changing one thing;
the current preset leads, and the wrong-pointer leg is kept beside it because it is what establishes
the rule:

| `long-buried` bgrun arm | pointer | `calls` | `ctx_chars` | `wall_s` |
|---|---|---|---|---|
| `tracepreset-fixed` — current preset | **correct** | 5, 5, 8 | **33,799** [29,180–36,355] | 234.0 |
| baseline | none | 3, 4, 4 | 18,760 [16,365–21,056] | 225.9 |
| `tracepreset` | **wrong** | 5, 5, 6 | 28,633 [21,867–31,481] | 233.1 |

Sources: `runs/long-buried/profile.csv`, `runs/long-buried-tracepreset/profile.csv`,
`runs/long-buried-tracepreset-fixed/profile.csv`, and `runs/long-buried/CELL.md`. Ranges do not
overlap on calls (baseline max 4, both variants min 5) or context (baseline max 21,056, correct
variant min 29,180). Both variants reached the same `part-05.test.ts`.

- **The current preset** (`runs/long-buried-tracepreset-fixed/`, three bgrun sessions, vanilla
  omitted by design) requires real evidence before naming anything, and named the *true* failure
  (`AssertionError … at TestContext.<anonymous> (/private/tmp/long-buried-fixture/part-05.test.ts:59:9)`)
  — and cost the most, not the least.
- **The wrong-pointer run** (`runs/long-buried-tracepreset/`), configured
  `{ "preset": "js-trace", "on": "failure" }`, named `Failure: (pass) preset js-trace corpus
  (captured): …` — **a passing test's name**, because the suite under test contains the preset's own
  corpus tests and prints captured failure text. Sessions did not trust it and searched anyway.

**Reading: a pointer is a lead to verify, not an answer.** Even a correct pointer made the sessions
work harder (sequence `bgrun bggrep bggrep bgtail bggrep`), because the wake's own honest hedge
marks it as one failure rather than the whole story. The pointer competes with a cheap search rather
than replacing one. Full treatment: product issue
[#33](https://github.com/stablekernel/pi-background-run/issues/33).

## Where bgrun does not help

**Every short-job cell is a loss or a tie on wall time.** `trace-root` (40.7s vs 34.5s) and
`red-tail-short` (46.7 [40.3–50.7] vs 35.0 [34.4–38.6]) both put the background arm behind. Those
jobs run 23–34s, so the arm pays the job plus its turns around the wake while vanilla pays the same
waiting inside one call. The wake is not slow — in `red-tail-short` it lands 4ms after the job exits
in all three sessions, and `trace-root` shows the same millisecond delivery (`exitedAt` and the wake
timestamp in `runs/red-tail-short-v080/sessions/bgrun-*` and
`runs/trace-root-framewake/sessions/bgrun-*`) — so the penalty is the session's own work plus a
round trip it cannot avoid: 46.7s against a ~24.4s job leaves ~22s of the arm's own turns. A failure
one window from the end means the wake buys back the search and little else: context is 13,941
[12,876–16,534] against vanilla's 30,056 and calls are 4, 3, 3. bgrun's genuinely owned win here is
`blocked_s` 0.0 — it never blocks the session — paid for in wall time.

**The pointer is a cost, not a benefit, when the session can search.** Wrong and correct pointers
both cost more calls and context than no pointer at all.

## Limits

n=3 per arm, one model (`anthropic/claude-sonnet-4-6`), one synthetic fixture family, one machine;
three runs demonstrate an effect and claim no significance, and every cell was human-driven (`H6
<unattended>` is negative on this setup). `ctx_chars` counts characters of transcript text, not
billed tokens. The fixture has no flaky tests, retries, parallel workers or enormous stack traces,
and the pointer workload is the extension's own suite — a pathological digest input, so the pointer
*rule* generalises further than the pointer *number*. **The command in every cell also runs this
repository's own test suite, and its size changes between revisions as tests are added** (the
presets work alone added 718 lines to it). The fixture's workload is pinned behaviourally; that
repo-suite margin is not, so the absolute figures belong to the revision each cell ran against —
the mechanism findings do not depend on it ([#40](https://github.com/stablekernel/pi-background-run/issues/40)).
Full statement of what the measurements do and do not support:
[`BENCHMARK.md`](../../BENCHMARK.md).

## Glossary

Plain definitions of the terms used above, each in the sense the documents under
[Where to start](#where-to-start) use it.

- **arm** — a condition a cell compares: `vanilla` (`pi` with no bgrun), `bgrun` (`pi` plus this
  repo's extension), or `vanilla-hinted` (vanilla told to redirect the run to a file and grep it —
  the technique bgrun implements, hand-rolled by the agent). Every number here is per arm.
- **baseline** — the condition a variant is measured against; in the pointer table, the same cell
  with no digest configured, so the wake carries no pointer.
- **`blocked_s`** — seconds the session spent waiting on a *foreground* suite run. A **mechanism**
  column: a detached job cannot block its session, so bgrun's 0.0 is structural.
- **`cause_file`** — the deepest trace frame *that session saw* — session-relative, so it reads 1
  for a session that never saw the real cause. Read it with `cause_reached`.
- **`cause_reached`** — whether the session reached the failure's *cause* (the frame in the other
  file), not just its symptom, and carried it into the answer; a presence-only metric cannot show
  this, since a session can find the symptom, report it and stop with every other column healthy.
- **cell** — one **fixture × arm × context** at one model. Compare only within a cell, and only
  between runs that share a manifest.
- **`ctx_chars`** — characters of transcript text (every non-empty text/thinking part), not billed
  tokens; an **agent** column, varying between runs of one cell by design.
- **digest** — the compact summary `bgrun` puts into the wake (`.pi/pi-bgrun.json`). With none, the
  wake carries exit status and the log's last line; a digest block is by default **counts only**
  (`299 pass`, `1 fail`) and never names the failing test.
- **fixture knobs** — the `DUMMY_*` variables that generate the fixture (`DUMMY_SLEEP_MS` time,
  `DUMMY_LINES_PER_TEST` volume, `DUMMY_FAIL_FILE`/`DUMMY_FAIL_STEP` failure position,
  `DUMMY_ANNOUNCE_FAILURE`, `DUMMY_CAUSE_MODULE`, `DUMMY_FAIL_FAST`). Generated, not committed: the
  knobs and the behaviour they produce are its identity, and its sha is a digest for reference,
  never the contract.
- **hypotheses (`H1`–`H12`)** — pre-registered claims, written **before** the runs and never edited
  after; they live in [`predictions.md`](predictions.md), with outcomes in
  [`results.md`](results.md). `H1` pty-shape · `H2` shape-drives-reading · `H3` variance-not-median
  · `H4` negative-cells · `H5` mechanism-stable · `H6` unattended · `H7` capability · `H8`
  ladder-gradient · `H9` digest-starves · `H10` condenser-eats-traces · `H11` trace-depth · `H12`
  fabricated-wake. Cells are named separately, so a cell and a claim are not confused.
- **pointer** — the failing test's name and its source frame, put into the wake by a trace preset or
  the `on: "failure"` gate; a lead the session must verify, not an answer.
- **repo-suite margin** — every cell's command runs this repository's own suite **as well as** the
  fixture, and the repo's share grows as tests are added (the presets work alone added 718 lines);
  the fixture is pinned behaviourally, this margin is not, so absolute figures belong to the
  revision each cell ran against
  ([#40](https://github.com/stablekernel/pi-background-run/issues/40)).
- **trace preset** — a named digest rule (`js-trace`) putting a **pointer** into the wake, typically
  gated `on: "failure"`.
- **wake** — the completion notification a detached job delivers to the live session that handed it
  off. It is why every bgrun cell is a live session: a one-shot session is gone before the job ends.
- **wake claim** — a session asserting it received a wake it had not received — an invented licence
  to keep checking, not impatience; counted as `claims_before_exit` in `wake-claims.csv`, zero in
  every current cell.

→ [`BENCHMARK.md`](../../BENCHMARK.md) (full findings and history) · [`method.md`](method.md) (how
it was measured) · [`results.md`](results.md) (every cell, outcome and earlier generation) ·
[`predictions.md`](predictions.md) (the register) · [`runs/`](runs/) (the raw records)

The rules these records follow — how a number is shown, and how history is kept out of the current
picture — are stated in [`method.md`](method.md#recording-and-presentation-rules).
