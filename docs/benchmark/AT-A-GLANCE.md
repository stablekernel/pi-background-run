# bgrun at a glance

`bgrun` hands a long shell command to a background job so the session stays unblocked and
the command's output never enters the conversation; the price is the wake — the session
still has to wait for the job's completion notification before it can act on the result.
Measured at n=3 per arm on one model (`anthropic/claude-sonnet-4-6`), that price is
decided by **how long the job runs**: for a ~23–34s job the wake's round trip costs more
than it saves, while for a ~204s job the background arm pays the job once and the
synchronous arm pays it over and over by re-running the suite. The tool's one structural
win in every cell is that it never blocks the session (`blocked_s` 0.0, against 22.5–660.2s
of foreground waiting). Below: one section per measured cell, then the three-way pointer
result, then where it does not help. Every figure cites the cell's `profile.csv`; the full
case and limits are in [`BENCHMARK.md`](../../BENCHMARK.md).

Cells: [`red-tail-short`](#red-tail-short--failure-near-the-end-of-a-short-run) ·
[`long-buried`](#long-buried--a-failure-buried-in-a-long-noisy-run) ·
[`trace-root`](#trace-root--symptom-at-the-end-cause-three-frames-down-another-file) ·
[pointer variants](#the-three-way-pointer-result)

**The rule.** The figures shown are the **current tool's**. A superseded run appears only as
*labelled* history inside the section whose finding it supports ("before the poll fix"), never
as a competing headline; where a cell has both a current and an earlier run, the current one
leads and the earlier one follows, marked as history. A cell whose newest run predates a change
to the tool it exercises is marked **awaiting a re-run** rather than presented as current.
(Where a run generation is named below, the tool changes it covers — the poll fix, the wake's
closing line, the trace presets and failure gate, the js-trace evidence rule — all landed
together, merged as `6b04d24`.)

## `red-tail-short` — failure near the end of a short run

**What it tested.** The repo's own suite plus a fixture that fails near the end of the
output: a short run whose diagnostic is one tail-window away. Does the background handoff
buy anything when the failure is cheap to reach?

**Current run — the current tool (0.8.0).** The newest run of this cell
(`runs/red-tail-short-v080/`) is the same fixture, model, prompt and command on the current tool,
carrying both the poll fix and the wake's closing-line change (merged as `6b04d24`, released 0.8.0).
It leads.

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 46.7 [40.3–50.7] | **35.0** [34.4–38.6] |
| `ctx_chars` | **13,941** [12,876–16,534] | 30,056 [29,962–30,183] |
| `calls` | 4, 3, 3 | 1 [1–1] |
| `blocked_s` (mechanism) | 0.0 | 24.3 |

Source: `runs/red-tail-short-v080/profile.csv` (summary rows). The interaction is `bgrun` → yield →
wake → search → one window → answer: two sessions ran `bgrun bggrep bgtail`, the third (`bgrun-1`)
added a second `bggrep`. No session polled a running job or claimed a wake it had not received
(`wake-claims.csv`: `claims_before_exit` 0, 0, 0 and polls 0, 0, 0), so `H12` stays fixed on the
current tool. The wake's closing line — the change `trace-root` below shows fixing a short cell —
costs the same increment here against Cell 1b: **calls 2 → 3–4 and context 9,892 → 13,941**, because
the session opens a window on the log instead of answering from the summary. Wall stays negative, as
the floor argument predicts for a ~24.4s job: 46.7s against 35.0s.

### The finding this cell produced (`H12`) — its two earlier generations

**Cell 1b — post-poll-fix, pre-framing (labelled history).** Cell 1's fabricated-wake loop was fixed
in the extension and the cell re-run, before the wake's closing line changed. The fix removed the
loop outright and **inverted** the context result:

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 40.9 [38.1–42.7] | **33.5** [32.3–33.9] |
| `ctx_chars` | **9,892** [9,841–10,031] | 28,021 [28,000–28,236] |
| `calls` | 2 [2–2] | 1 [1–1] |
| `blocked_s` (mechanism) | 0.0 | 22.4 |

Source: `runs/red-tail-short-fixed/profile.csv` (summary rows). With the log gated behind the wake the
arm searched it rather than reading it in pieces (`locate` flipped `position` → `pattern`), so context
came in *below* vanilla's — the 12% penalty of Cell 1 inverted (9,892 against 28,021). These are the
**pre-framing** numbers: they predate the wake's closing-line change, and the current run above is the
one that supersedes them. Wall stayed negative there for the same floor reason.

**Cell 1 — pre-poll-fix (labelled history).** The run Cell 1b exists because of. On the extension
before the fix, every bgrun session polled a job it had just handed off, each claiming a wake it had
never received:

| metric (median [min–max]) | bgrun (pre-fix) | vanilla |
|---|---|---|
| `wall_s` | **45.4** [42.9–51.1] | 33.0 [32.5–38.2] |
| `ctx_chars` | 31,170 [29,403–31,782] | 27,817 [27,798–27,870] |
| `calls` | 11 [9–12] | 1 [1–1] |
| `blocked_s` (mechanism) | 0.0 | 22.5 |

Source: `runs/red-tail-short/profile.csv` (summary rows). The bgrun arm was *slower* and cost
12% more context, and neither wall nor context range overlapped; the only win was `blocked_s`.

Vanilla ran the suite once in the foreground, blocked 22.5s, and read the whole
~26.6k-character result in a single call. Each bgrun session instead handed off, then read the
log in pieces while it ran: bgrun-1 made 12 calls (1 `bgrun`, 10 `bgtail`, 1 `bgstatus`),
bgrun-3 made 9, six of them `bggrep` (the cell's prose says five; the profile count is six).
The polling was licensed by a fabricated wake — bgrun-1's own text reads *"I'll wait for the
results — you'll be woken automatically when the tests finish. --- **Wake received.** Let me
check the failure details."*, then later *"Still running — waiting for it to finish."* The
real wake arrived ~8s after the job exited, so the arm front-ran it: the three sessions made
11, 10 and 6 calls while the job was still running (against 1, 1 and 3 after it exited), and
each first claimed a wake 3–4s into a ~23s job. 27 of the three sessions' 30 tool calls were
made while the job was still running, and the fix drove that — and the claims — to zero:

| metric | pre-fix (Cell 1) | post-poll-fix, pre-framing (Cell 1b) | current, 0.8.0 (Cell 1c) |
|---|---|---|---|
| wake claims before exit | 1, 2, 1 | **0, 0, 0** | **0, 0, 0** |
| polls before exit | 10, 9, 5 | **0, 0, 0** | **0, 0, 0** |
| tool calls per session | 12, 11, 9 | 2, 2, 2 | 4, 3, 3 |
| `ctx_chars` (median) | 31,170 | 9,892 | 13,941 |
| `wall_s` (median [min–max]) | 45.4 [42.9–51.1] | 40.9 [38.1–42.7] | 46.7 [40.3–50.7] |

Sources: `runs/red-tail-short/profile.csv`, `runs/red-tail-short-fixed/profile.csv` and
`runs/red-tail-short-v080/profile.csv`.

## `long-buried` — a failure buried in a long noisy run

**What it tested.** Ten fixture parts with the failure in `part-05` (the only part with a
real assertion cluster), so a tail read has nothing to find: 570 tests, 1,281 lines, ~204s
per run. This is the regime the async handoff is *for*.

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | **225.9** [223.1–228.4] | 696.2 [283.8–732.4] |
| `blocked_s` (mechanism) | **0.0** | 660.2 |
| `ctx_chars` | **18,760** [16,365–21,056] | 79,901 [66,792–86,836] |
| `calls` | 3, 4, 4 | 12, 2, 6 |
| cause reached (`part-05.test.ts`) | 3/3 | 3/3 |

Source: `runs/long-buried/profile.csv` (summary rows). This is the current tool with no
digest configured — the later preset change is never exercised without one — so it leads as
current. The first cell where bgrun wins on both axes — 3.1× faster and 4.3× lighter — with
the diagnosis a tie.

**What each arm actually did.** bgrun paid the ~204s job once: bgrun-1 made two `bggrep`
calls and stopped, bgrun-3 added a `bgtail` for context, and the median session is 225.9s
≈ the job plus ~22s of agent work. Vanilla paid it repeatedly: vanilla-2 ran the whole
suite twice (two full-read calls, the second waiting 203.6s, 86,836 characters by the end),
and vanilla-1 made 12 calls across 8 foreground runs, grepping and re-running the suite
while choosing how many times to try. Both arms reached `part-05.test.ts:59`; bgrun bought
the same answer at a quarter of the context because vanilla bought it by reading everything.

## `trace-root` — symptom at the end, cause three frames down another file

**What it tested.** The failure's *cause* lives in a file of its own (`harness.ts`),
reachable through a stack frame the failure's own wording never mentions. Symptom cheap to
find; cause one frame down.

**Current run — the wake's closing line fixed.** Two sentences of language-neutral framing
(*"a summary, not the diagnosis — the log holds the detail… read a window around the failure
before concluding a cause."*) replaced *"the exit code, stats and last output above **are the
result**"*, and that alone moved the cell. Same fixture, model and prompt; no digest, no
preset, no pointer.

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 40.7 [39.2–43.9] | **34.5** [33.2–34.6] |
| `ctx_chars` | **14,009** [13,559–16,243] | 29,721 [29,610–29,731] |
| `calls` | 3 | 1 |
| `harness.ts` in context | **3, 3, 5** (was 0, 0, 0) | — |
| deepest frame seen | **`harness.ts`** (was `part-02.test.ts`) | `harness.ts` |

Source: `runs/trace-root-framewake/profile.csv` (summary rows) and
`runs/trace-root-framewake/CELL.md`. Vanilla's own run is unmoved (single full read).

**What each arm actually did.** The sequences gained exactly one step: the before-run's
sessions ran `bgrun` → `bggrep` and stopped at the symptom; the current run's added a third
call — `bgtail` in two of the three sessions (bgrun-1, bgrun-3), a second `bggrep` in the
other — to reach the window where the frames sit. bgrun-1's thinking reads *"Let me look at
the test failures in the log"*, and its answer now names the harness: *"**Harness:**
…/harness.ts:28"*. The extra call cost ~4k characters and bought the cause — still at half
vanilla's context. Two sentences of language-neutral instruction, which know nothing about how
any runner spells a stack frame, fixed what the JS/TS-tuned built-in locator never did.

### Before the wake's closing line changed — the cause-loss finding

The current run exists because this one lost the cause. Cell 3 (`runs/trace-root/`), on the
extension whose wake closed with *"the exit code, stats and last output above **are the
result**"*, never reached `harness.ts`:

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 37.5 [37.1–39.5] | **34.5** [34.4–36.2] |
| `ctx_chars` | **9,758** [9,757–10,061] | 28,271 [28,248–28,379] |
| `calls` | 2 | 1 |
| `harness.ts` in context | **0, 0, 0** | **2, 2, 2** |
| deepest frame seen | `part-02.test.ts` | `harness.ts` |

Source: `runs/trace-root/profile.csv` (summary rows) and `runs/trace-root/CELL.md`.

Vanilla ran the suite synchronously; the single ~27k-char result carried the whole log, so
the cause frame came with it — one session names it outright: *"Assertion error in
`harness.ts:28`"*. Every bgrun session ran `bgrun` → one `bggrep` → answer, searching for
failure words (`(?i)(fail|✗|×|error|expect)`), which match the assertion and the runner's
`(fail)` line but not the frame line `at loadStep (.../harness.ts:28:9)` — it contains no
failure word. The barrier was the wake's framing, not a missing capability (no digest was
configured here, so the wake carried no digest block): the closing line gave no reason to open
the window around the failure, so the grep filtered the cause out. The arm's answer cited
`part-02.test.ts` with line numbers (28, 41) that actually belong to `harness.ts`: numbers
without their file. This was the tool's saving and its blind spot in the same mechanism — 65%
less context, but the saving was bought with the diagnosis.

## The three-way pointer result

The `on: "failure"` gate and the trace presets put a *pointer* — a named failing test and
its source frame — into the wake. Cell 4 (`long-buried`) ran that layer three ways, each
changing one thing. The current preset leads; the wrong-pointer run it superseded is kept
below it as the marked comparison:

| `long-buried` bgrun arm | pointer | `calls` | `ctx_chars` | `wall_s` |
|---|---|---|---|---|
| `tracepreset-fixed` — **current** | **correct** | 5, 5, 8 | **33,799** [29,180–36,355] | 234.0 |
| baseline | none | 3, 4, 4 | 18,760 [16,365–21,056] | 225.9 |
| `tracepreset` — *before the pointer fix* | **wrong** | 5, 5, 6 | 28,633 [21,867–31,481] | 233.1 |

Sources: `runs/long-buried/profile.csv`, `runs/long-buried-tracepreset/profile.csv`,
`runs/long-buried-tracepreset-fixed/profile.csv`, and `runs/long-buried/CELL.md`. Ranges do
not overlap on calls (baseline max 4, both variants min 5) or context (baseline max 21,056,
correct variant min 29,180). Both variants reached the same `part-05.test.ts`.

- **The current preset** (`runs/long-buried-tracepreset-fixed/`, three bgrun sessions,
  vanilla omitted by design) requires real evidence before naming anything, and named the
  *true* failure
  (`AssertionError … at TestContext.<anonymous> (/private/tmp/long-buried-fixture/part-05.test.ts:59:9)`)
  — and cost the most, not the least.
- **The superseded wrong-pointer run** (`runs/long-buried-tracepreset/`), kept as the
  before-half of the fix, configured `{ "preset": "js-trace", "on": "failure" }`; the digest
  named `Failure: (pass) preset js-trace corpus (captured): …` — **a passing test's name**,
  because the suite under test contains the preset's own corpus tests and prints captured
  failure text. Sessions did not trust it and searched anyway.

**Reading: a pointer is a lead to verify, not an answer.** Even a correct pointer made the
sessions work harder (sequence `bgrun bggrep bggrep bgtail bggrep`), because the wake's own
honest hedge marks it as one failure rather than the whole story, and a lead invites
checking. The pointer competes with a cheap search rather than replacing one. Full treatment:
product issue [#33](https://github.com/stablekernel/pi-background-run/issues/33).

## Where bgrun does not help

**Every short-job cell is a loss or a tie on wall time.** `trace-root` (current, 40.7s vs
34.5s) and `red-tail-short` (current run, 46.7 [40.3–50.7] vs 35.0 [34.4–38.6]) both put the
background arm behind, and before the poll fix `red-tail-short` was worse still (45.4s vs
33.0s). The reason is structural: those jobs run 23–34s, so the arm pays the job plus the turns
it makes around the wake, while vanilla pays the same waiting inside a single call — the round
trip dominates. A failure close to the end of the output is one window away, so the wake adds a
round trip and buys nothing. The poll fix removed the self-inflicted cost (the polling loop
above): on `red-tail-short`'s current run context is 13,941 [12,876–16,534] against vanilla's
30,056 and calls are 4, 3, 3, and the pre-framing Cell 1b was lighter still at 9,892 [9,841–10,031].
Wall stayed negative in every generation because that part is the job plus the wake, not the
agent. bgrun's genuinely owned win in these cells is `blocked_s` 0.0 — it never blocks the
session — paid for in session wall time.

**The pointer is a cost, not a benefit, when the session can search.** The three-way above:
wrong and correct pointers both cost more calls and context than no pointer at all.

## Limits

n=3 per arm, one model (`anthropic/claude-sonnet-4-6`), one synthetic fixture family, one
machine; three runs demonstrate an effect and claim no significance, and every cell was
human-driven (`H6 <unattended>` is negative on this setup). `ctx_chars` counts characters of
transcript text, not billed tokens. The fixture has no flaky tests, retries, parallel workers
or enormous stack traces, and the pointer workload is the extension's own suite — a
pathological digest input, so the pointer *rule* generalises further than the pointer
*number*. **The command in every cell also runs this repository's own test suite, and its
size changes between revisions as tests are added** (the presets work alone added 718 lines
to it). The fixture's workload is pinned behaviourally; that repo-suite margin is not, so the
absolute figures belong to the revision each cell ran against — the mechanism findings do
not depend on it. Tracked as [#40](https://github.com/stablekernel/pi-background-run/issues/40).
Full statement of what the measurements do and do not support: [`BENCHMARK.md`](../../BENCHMARK.md).

→ [`BENCHMARK.md`](../../BENCHMARK.md) (full findings) · [`method.md`](method.md) (how it was
measured) · [`results.md`](results.md) (every cell and outcome) · [`predictions.md`](predictions.md)
(the register) · [`runs/`](runs/) (the raw records)

The rules these records follow — how a number is shown, what is labelled history, and what
counts as awaiting a re-run — are stated in [`method.md`](method.md#recording-and-presentation-rules).
