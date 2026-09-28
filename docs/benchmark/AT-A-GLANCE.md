# bgrun at a glance

`bgrun` hands a long shell command to a background job so the session stays unblocked and
the command's output never enters the conversation; the price is the wake — the session
still has to wait for the job's completion notification before it can act on the result.
Measured at n=3 per arm on one model (`anthropic/claude-sonnet-4-6`), that price is
decided by **how long the job runs**: for a ~23–34s job the wake's round trip costs more
than it saves, while for a ~204s job the background arm pays the job once and the
synchronous arm pays it over and over by re-running the suite. The tool's one structural
win in every cell is that it never blocks the session (`blocked_s` 0.0, against 22.5–660.2s
of foreground waiting). Below: one section per measured cell, then where it does not help,
then the three-way pointer result. Every figure cites the cell's `profile.csv`; the full
case and limits are in [`BENCHMARK.md`](../../BENCHMARK.md).

Cells: [`red-tail-short`](#red-tail-short--failure-near-the-end-of-a-short-run) ·
[`long-buried`](#long-buried--a-failure-buried-in-a-long-noisy-run) ·
[`trace-root`](#trace-root--symptom-at-the-end-cause-three-frames-down-another-file) ·
[`trace-root-framewake`](#trace-root-framewake--the-same-cell-one-closing-line-changed) ·
[pointer variants](#the-three-way-pointer-result)

## `red-tail-short` — failure near the end of a short run

**What it tested.** The repo's own suite plus a fixture that fails near the end of the
output: a short run whose diagnostic is one tail-window away. Does the background handoff
buy anything when the failure is cheap to reach?

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | **45.4** [42.9–51.1] | 33.0 [32.5–38.2] |
| `ctx_chars` | 31,170 [29,403–31,782] | 27,817 [27,798–27,870] |
| `calls` | 11 [9–12] | 1 [1–1] |
| cause reached (`diag_reach`) | 3/3 | 3/3 |
| `blocked_s` (mechanism) | 0.0 | 22.5 |

Source: `runs/red-tail-short/profile.csv` (summary rows). The bgrun arm is *slower* and
costs 12% more context, and neither wall nor context range overlaps; the only win is
`blocked_s`.

**What each arm actually did.** Vanilla ran the suite once in the foreground, blocked
22.5s, and read the whole ~26.6k-character result in a single call. Each bgrun session
instead handed off, then read the log in pieces while it ran: bgrun-1 made 12 calls
(1 `bgrun`, 10 `bgtail`, 1 `bgstatus`), bgrun-3 made 9, six of them `bggrep` (the cell's
prose says five; the profile count is six). The polling was licensed by a fabricated wake —
bgrun-1's own text reads *"I'll wait for the results — you'll be woken automatically when
the tests finish. --- **Wake received.** Let me check the failure details."*, then later
*"Still running — waiting for it to finish."* The real wake arrived ~8s after the job
exited, so the arm front-ran it: the three sessions made 11, 10 and 6 calls while the job
was still running (against 1, 1 and 3 after it exited), and each first claimed a wake
3–4s into a ~23s job. The fix (below, in "where bgrun does not help") removed the
polling but not the wall penalty.

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

Source: `runs/long-buried/profile.csv` (summary rows). The first cell where bgrun wins on
both axes — 3.1× faster and 4.3× lighter — with the diagnosis a tie.

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

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 37.5 [37.1–39.5] | **34.5** [34.4–36.2] |
| `ctx_chars` | **9,758** [9,757–10,061] | 28,271 [28,248–28,379] |
| `calls` | 2 | 1 |
| `harness.ts` in context | **0, 0, 0** | **2, 2, 2** |
| deepest frame seen | `part-02.test.ts` | `harness.ts` |

Source: `runs/trace-root/profile.csv` (summary rows) and `runs/trace-root/CELL.md`.

**What each arm actually did.** Vanilla ran the suite synchronously; the single ~27k-char
result carried the whole log, so the cause frame came with it — one session names it
outright: *"Assertion error in `harness.ts:28`"*. Every bgrun session ran `bgrun` → one
`bggrep` → answer, searching for failure words (`(?i)(fail|✗|×|error|expect)`), which match
the assertion and the runner's `(fail)` line but not the frame line
`at loadStep (.../harness.ts:28:9)` — it contains no failure word. The wake's closing line
(*"the exit code, stats and last output above **are the result**"*) gave no reason to open
the window around the failure, so the grep filtered the cause out. The arm's answer cited
`part-02.test.ts` with line numbers (28, 41) that actually belong to `harness.ts`: numbers
without their file. This is the tool's saving and its blind spot in the same mechanism —
65% less context, but the saving was bought with the diagnosis.

## `trace-root-framewake` — the same cell, one closing line changed

**What it tested.** Nothing about the tool changed but the wake's closing line, from *"the
exit code, stats and last output above **are the result**"* to *"a summary, not the
diagnosis — the log holds the detail… read a window around the failure before concluding a
cause."* No digest, no preset, no pointer. Same fixture, model and prompt.

| metric (median [min–max]) | bgrun | vanilla |
|---|---|---|
| `wall_s` | 40.7 [39.2–43.9] | **34.5** [33.2–34.6] |
| `ctx_chars` | **14,009** [13,559–16,243] | 29,721 [29,610–29,731] |
| `calls` | 3 | 1 |
| `harness.ts` in context | **3, 3, 5** (was 0, 0, 0) | — |
| deepest frame seen | **`harness.ts`** (was `part-02.test.ts`) | `harness.ts` |

Source: `runs/trace-root-framewake/profile.csv` (summary rows) and
`runs/trace-root-framewake/CELL.md`. Vanilla's own run is unmoved (single full read).

**What each arm actually did.** The sequences gained exactly one step: Cell 3's sessions ran
`bgrun` → `bggrep` and stopped at the symptom; Cell 3a's added a third call — `bgtail` in two
of the three sessions (bgrun-1, bgrun-3), a second `bggrep` in the other — to reach the window
where the frames sit. bgrun-1's thinking reads *"Let me look at the test
failures in the log"*, and its answer now names the harness: *"**Harness:** …/harness.ts:28"*.
The extra call cost ~4k characters and bought the cause — still at half vanilla's context.
Two sentences of language-neutral instruction, which know nothing about how any runner
spells a stack frame, fixed what the JS/TS-tuned built-in locator never did.

## The three-way pointer result

The `on: "failure"` gate and the trace presets put a *pointer* — a named failing test and
its source frame — into the wake. Cell 4 (`long-buried`) ran that layer three ways, each
changing one thing:

| `long-buried` bgrun arm | pointer | `calls` | `ctx_chars` | `wall_s` |
|---|---|---|---|---|
| baseline | none | 3, 4, 4 | 18,760 [16,365–21,056] | 225.9 |
| `tracepreset` | **wrong** | 5, 5, 6 | 28,633 [21,867–31,481] | 233.1 |
| `tracepreset-fixed` | **correct** | 5, 5, 8 | **33,799** [29,180–36,355] | 234.0 |

Sources: `runs/long-buried/profile.csv`, `runs/long-buried-tracepreset/profile.csv`,
`runs/long-buried-tracepreset-fixed/profile.csv`, and `runs/long-buried/CELL.md`. Ranges do
not overlap on calls (baseline max 4, both variants min 5) or context (baseline max 21,056,
correct variant min 29,180). Both variants reached the same `part-05.test.ts`.

- **The wrong-pointer run** (`runs/long-buried-tracepreset/`) configured
  `{ "preset": "js-trace", "on": "failure" }`; the digest named
  `Failure: (pass) preset js-trace corpus (captured): …` — **a passing test's name**, because
  the suite under test contains the preset's own corpus tests and prints captured failure
  text. Sessions did not trust it and searched anyway.
- **The fixed-pointer run** (`runs/long-buried-tracepreset-fixed/`, three bgrun sessions,
  vanilla omitted by design) named the *true* failure
  (`AssertionError … at TestContext.<anonymous> (/private/tmp/long-buried-fixture/part-05.test.ts:59:9)`)
  — and cost the most, not the least.

**Reading: a pointer is a lead to verify, not an answer.** Even a correct pointer made the
sessions work harder (sequence `bgrun bggrep bggrep bgtail bggrep`), because the wake's own
honest hedge marks it as one failure rather than the whole story, and a lead invites
checking. The pointer competes with a cheap search rather than replacing one. Full treatment:
product issue [#33](https://github.com/stablekernel/pi-background-run/issues/33).

## Where bgrun does not help

**Every short-job cell is a loss or a tie on wall time.** `red-tail-short` (45.4s vs 33.0s),
its post-fix re-run `red-tail-short-fixed` (40.9 [38.1–42.7] vs 33.5 [32.3–33.9]),
`trace-root` (37.5s vs 34.5s) and `trace-root-framewake` (40.7s vs 34.5s) all put the
background arm behind. The reason is structural: those jobs run 23–34s and the wake lands
about 7–8s after the job exits, so the arm's best case is vanilla's blocking minus a turn —
the round trip dominates. A failure close to the end of the output is one window away, so
the wake adds a round trip and buys nothing. The post-fix re-run did remove the self-inflicted
cost (the polling loop above): context fell to 9,892 [9,841–10,031] against vanilla's 28,021
and calls to 2, but wall stayed negative (40.9s against 33.5s) because that part is the job
plus the wake's arrival, not the agent. bgrun's genuinely owned win in these cells is
`blocked_s` 0.0 — it never blocks the session — paid for in session wall time.

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
