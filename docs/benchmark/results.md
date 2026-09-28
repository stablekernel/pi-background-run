# Results

Empty by design. This file holds what the battery measures, in the form the method
requires, and it stays empty until a cell actually runs. Predictions are in
[predictions.md](./predictions.md); the procedure that produces these rows is in
[method.md](./method.md).

## How a result is recorded

1. **Generated, not transcribed.** Rows come from
   `bun scripts/measure-sessions.ts` output. Nobody retypes a number into prose.
2. **Provenanced.** Every row cites its session directory, fixture hash and context
   (pty or pipe) from the run manifest, so any figure can be re-checked against the
   transcript it came from.
3. **Spreads, not points.** n≥3 with median *and* range, per arm. A single run is
   labelled as one, and never enters a comparison.
4. **Two kinds of column, kept apart.** Mechanism columns (`execs`, `fg`, `handoff`,
   `blocked_s`) are evidence about the tool; agent columns (`ctx_chars`, `wall_s`,
   `calls`, `locating`) are evidence about an agent driving it, and vary by design.
5. **Verdict against the prediction.** Each cell ends **confirmed**, **falsified**, or
   **inconclusive** — and a falsified cell keeps its row and gains a note. Predictions
   are never edited to match results.
6. **No cross-rung wall comparisons.** Ladder cells report each rung's own
   vanilla-versus-bgrun delta and its `locating` mix; wall-clock across rungs is
   meaningless because per-call latency differs.

## Status

| cell | prediction | status |
|---|---|---|
| `green-short` | vanilla by median, bimodal | not run |
| `red-tail-short` | vanilla by median | not run |
| `long-buried` | bgrun on executions and blocked; context undecided | not run |
| `fast-verbose` | struggle for bgrun | not run |
| `fail-fast` | struggle for bgrun | not run |
| `pty-fixture` | pty = pipe + a per-test line | **falsified** — see Instrument checks |
| ~~`pty-agent`~~ | — | **dropped**: void by `H1` |
| `overlap-task` | bgrun, if the agent actually overlaps | not run |
| `parallel-jobs` | bgrun on session availability, wall may tie | not run |
| `resume-midrun` | bgrun, magnitude uncertain | not run |
| `peek-midrun` | bgrun; low frequency | not run |

## Instrument checks

Not cells: the checks that decide whether a cell's numbers mean anything. Run before a
battery, recorded with the command that produced them.

### `pty-fixture` — the runner's output shape

**Prediction**: pty output = piped output + one per-test line (`H1 <pty-shape>`).

**Result: falsified.** Bun 1.3.6 is not terminal-aware; it is *environment*-aware.

| environment | pipe | pty | differing lines |
|---|---|---|---|
| `AGENT=1 CLAUDECODE=1 CI=true NO_COLOR=1 TERM=dumb` — a pi session's own | 82 | 82 | **0**: byte-identical |
| agent vars unset, `TERM=xterm-256color` | 87 | 87 | 12 — the per-test lines, format only: `✓ name` on the pty, `(pass) name [dur]` on the pipe |

Neither shape is ever larger. What changes the output is whether `AGENT` is set, and
whether `TERM` supports colour — not whether stdout is a terminal, and **not
`CLAUDECODE`**: measured on one 300-test fixture, `AGENT=1` alone gives 694 lines with no
per-test lines, `CLAUDECODE=1` alone gives 996 with all 301 of them, and both together
give 694 — the same as a session's own environment (`+ CI=true NO_COLOR=1 TERM=dumb`).
*Corrected 2026-09-26: this entry previously said "either alone suffices". The pty/pipe
probe that established the falsification only ever set both variables together, so it
never isolated them; the matrix above does.* Line counts are the signal here — the
per-test lines carry per-test durations, so byte-level hashes differ between runs even
in one environment.

This is also the explanation for the earlier round's unexplained line counts for one
command: it was the environment, not the terminal. And it makes the stream split matter
more in a session than outside one: with per-test lines suppressed, the failing test's
*name* is on stderr too, so a session that captures stdout only has no record of which
test failed and no trace — the fixture's own stage lines are all that is left.

At **full scale** (10 files, 300 tests) the same difference is 302 lines, and none of
them are the fixture's own — the breakdown, measured by diffing the two logs:

| contribution | lines |
|---|---|
| per-test lines (`(pass) name [dur]`) | 300 |
| the `1 tests failed:` block header | 1 |
| the blank line before that block | 1 |

Everything else matches exactly: fixture stage lines 600/600, file banners 10/10, frame
lines 9/9, `N pass` / `N fail` totals 2/2, `Ran N tests` 1/1. Note that the failing
test's `(fail) name [dur]` line stays in *both* — it is the failure block's own repeat of
the failing test, not a per-test line, which is why a "lines matching `(pass|fail)`" count
reads 301 vs 1 rather than 300 vs 0:

| environment | total lines | per-test lines | failure marker at |
|---|---|---|---|
| `AGENT=1 CLAUDECODE=1` | 694 | 0 | line 417 — 60% |
| agent vars empty, `TERM=xterm-256color` | 996 | 300 | line 611 — 61% |

The fixture's own stage lines (`[part 05 step 15] stage 1/2 — building…`) survive in both
environments. They are what remains of the failure's neighbourhood once the runner's
chatter is gone, which is why the cells can run in either.

**Stability**: four consecutive full-scale runs at `DUMMY_SLEEP_MS=600` returned
identical line counts and an identical failure position (996 / 301 per-test / line 611),
and 180s of wall every time. The fixture is deterministic; the environment is the only
thing that moves its shape.

**Execution order is not numeric.** `readdir` yields `02, 03, 01, 08, 09, 10, 05, 04, 06,
07`, so the planted failure in part 05 runs **7th of 10** and its marker sits at ~60% of
the output — **not** in the tail. Any cell that assumes the failure is at the end of the
output is wrong for this fixture.

**Provenance, including one failed check.** The environment leg was first run under
`bgrun`, whose shell does not inherit `AGENT`/`CLAUDECODE`: both labelled "environments"
were the same environment and all four runs returned the non-agent shape. The header
printed the environment, which is why the mistake was visible instead of being recorded
as a result — the numbers above are from a re-run with the variables set explicitly, and
the earlier four runs remain valid as run-to-run stability evidence within one
environment.

**Provenance**: `bun scripts/pty-shape.ts`, run in
`~/sk/pi-bgrun.ptyshape` at `8e63fc8`, then re-run in both
environments to confirm; `bun test scripts/pty-shape.test.ts` — 4 tests pass;
`tsc --noEmit` clean.

**Consequences**: `pty-agent` is dropped as void; the manifest records the environment;
no line count is quoted without one; the fixture's own line counts are re-measured per
environment before any cell depends on them.

### `trace-root` — the path a failure's evidence travels

**Prediction**: `H9 <digest-starves>`, `H10 <condenser-eats-traces>`.

**Result: the digest carries counts and nothing else.** For a run whose failing test is
`load part 05 > step 15`:

| the door the evidence comes through | content |
|---|---|
| the digest (configured `grep -E '[0-9]+ (pass\|fail)$' \| tail -5`) | `299 pass`, `1 fail` |
| the log's last line | `Ran 300 tests across 10 files. [179.81s]` |
| the failing test's name, its 9 frames, the marker pair | **only by opening the log** |

The failing test is never named, so a session that trusts the wake cannot reach the
symptom, let alone the cause. `H9` is therefore a *behavioural* question — do sessions
open the log unprompted — and `trace-root` leans vanilla until it is measured.

**The diagnosis is entirely on stderr.** Capturing stdout only, which is the obvious
`bun test … > log`:

| capture | lines | failing-test lines | frames | marker |
|---|---|---|---|---|
| stdout only | 619 | 0 | 0 | absent |
| stderr | 379 | 2 | 9 | present |

In an agent environment stdout-only loses the per-test lines as well, leaving the
fixture's own `the planted failure is part 05 step 15` line as the only clue — **and that
line is a crutch**, because a real project does not print where its planted failure is.
It has to become an axis (with and without) or go, or the cell measures the fixture's
help rather than the agent's work.

**Result: the condenser preserves the trace** — `H10 <condenser-eats-traces>`
**falsified, in the form it was stated**. A condensed read of the failure block kept the
assertion text, all 9 frames, both fixture locations and the markers; nothing was merged
or dropped. The narrow form it did not exercise: this trace has no *repeated* frames, so
the collapse rule had nothing to collapse.

**One tool defect recorded on the way, because it decides reachability**: a *wide*
condensed read truncates the newest lines rather than the oldest and advances coverage
past them, so a follow-up read reports "no new lines" and the log's end becomes
unreachable that way; `raw: true` returns the true tail. A session reading a log narrowly
gets the end but no frames; reading it widely gets frames but not the end.

**Provenance**: `bun scripts/env-shape.ts` — shape per environment, the stream split, the
digest and last-line content, and the crutch; it exits non-zero if both labelled
environments produce the same shape. The condenser half needs a job and `bgtail` on its
log (`h8b-trace-log`, 998 lines, marker at 611, frames at 617/655/656) and is not
reproducible from inside a single script.

### `H6` — the unattended method fails on stdin, not on the model

**Prediction**: an interactive session, held open in a pty, with the wake landing in it.

**Result so far: it cannot be held open that way.** Two smoke runs died identically — TUI
frozen one frame past the prompt at 2.4% context, no wake, no marker, no session file,
and a **byte-identical** log (4911 bytes) both times. Deterministic, not slow.

Cause, measured in three steps:

| step | observation |
|---|---|
| `script -q /dev/null sh -c 'read x'` with stdin `/dev/null` | the child reads immediate **EOF** — the pty's first byte is `^D` |
| the same with a pipe writer held open | still immediate EOF, so re-plumbing the *parent's* stdin is not the fix |
| `pi` in that pty | gone by the next sample (`pgrep -f`), **not** stopped; an earlier `ps` filter matched nothing and said nothing |

`pi`'s own TUI banner lists ctrl+d as exit, and a `bgrun` job runs with stdin
`/dev/null`, so the session quits mid-turn before its own job can finish. Without a pty
`pi` answers the turn, writes the session and exits — the same dead end, reached a
different way.

**Consequence if no pty-input hold works**: `H6` is falsified for this setup and the
method's fallback applies — cells a human drives are measured from a run-sheet, and this
file states which ones they were. That is a *method* difference between cells, not a
footnote, because it changes what may be claimed for them.

**The last variant failed too.** A pty whose input is held open by a FIFO writer (rather
than `/dev/null`) does not rescue it: the reader blocks on the named pipe and the probe had
to be killed by its own five-minute timeout. That route is not merely unproven but
unusable as a job — a hung probe is worse than a failed one.

**Verdict: `H6 <unattended>` is negative on this setup.** With stdin `/dev/null` the
session exits before its own job can finish; without a pty it exits as soon as its turn is
done; holding the input open hangs instead. Cells a human drives are therefore measured
from a run-sheet, and this file states which ones those were — a *method* difference
between cells, because it bounds what may be claimed for them.

### The attended method — verified (pilot, 2026-09-26)

`H6` being negative does not leave the method untested; it leaves the *unattended* claim
untested. Two human-driven sessions on one fixture checked the rest of the loop — that a
bgrun job's wake lands in a live session, and that the session acts on it. Raw transcripts
and the per-run table: [runs/pilot](./runs/pilot/MANIFEST.md).

| run | execs | handoff | fg | blocked_s | wall_s | ctx_chars | diag | locate | calls |
|---|---|---|---|---|---|---|---|---|---|
| manual-1 | 1 | 1 | 0 | 0.0 | 8.3 | 3,903 | up+down | `position` | 2 |
| manual-2 | 1 | 1 | 0 | 0.0 | 8.3 | 4,427 | up+down | `position` | 2 |

**Result: the loop works, twice, identically.** Both wakes landed and were acted on; both
sessions read the job's log with `bgtail` rather than grepping it — `position`, the first
real values that column has ever held; neither ran the suite in the foreground; blocked
time is 0.0s in both. Wall is identical to the tenth of a second and context varies 13%
between runs, which is the repeatability a battery needs before any cell means anything.

**A trap the pilot found, worth more than the result**: the profiler treats a *directory*
target as **one** session (its first `*.jsonl`, sorted), so pointing it at a flat session
dir silently profiles one run and drops the others — the exact "the tool has it, nothing
says what was skipped" failure this method exists to prevent. One directory per run, or
pass the transcript files by name.

**Where the battery starts, after the trim** (agreed 2026-09-26): the three `H7`-critical
cells — `long-buried`, `red-tail-short`, `trace-root` — at **one rung** first
(`anthropic/claude-sonnet-4-6`), both arms, n=3. Cheapest first: `red-tail-short`, whose
suite runs in about 25s. With one rung the *cells* are tested and the ladder hypotheses
(`H7`, `H8`, `H11`) are not — that is the trade the trim makes explicitly rather than by
omission, and it is reversible: the ladder widens only if the arm effect shows up at all.

## Capability ladder

Crossed with `red-tail-short`, `long-buried` and `trace-root`. All three rungs are
probed and usable: the gateway catalogue probe (`rung-probe3`, 32 non-bedrock ids) reads
`OK` for `anthropic/claude-haiku-4-5-20251001`, `anthropic/claude-sonnet-4-6` and
`anthropic/claude-opus-5`, and the unattended-session smoke additionally drove haiku
end-to-end in a session. The `anthropic/claude-opus-4-5…4-8` series is also served, which
would make a purer same-line ladder — at a much smaller capability gap than
haiku→sonnet→opus, which is the axis `H7`/`H11` need.

| rung | model | `red-tail-short` | `long-buried` | `trace-root` |
|---|---|---|---|---|
| weak | `anthropic/claude-haiku-4-5` | not run | not run | not run |
| mid | `anthropic/claude-sonnet-4-6` | **done** — [Cell 1](#cell-1--red-tail-short-measured-2026-09-28) | not run | not run |
| strong | `anthropic/claude-opus-5` | not run | not run | not run |
| floor probe (not a rung) | `fireworks/gpt-oss-120b` | not run | not run | not run |

## Cell 1 — `red-tail-short`, measured 2026-09-28

The first real cell: six sessions (3 bgrun / 3 vanilla) at `anthropic/claude-sonnet-4-6`, the
neutral prompt, one session directory each, interleaved. Full record, provenance and instrument
notes: [runs/red-tail-short/CELL.md](runs/red-tail-short/CELL.md); raw numbers:
[runs/red-tail-short/profile.csv](runs/red-tail-short/profile.csv).

| metric, median [min–max] | bgrun | vanilla |
|---|---|---|
| wall_s | 45.4 [42.9–51.1] | 33.0 [32.5–38.2] |
| blocked_s | 0.0 [0.0–0.0] | 22.5 [22.5–22.6] |
| ctx_chars | 31,170 [29,403–31,782] | 27,817 [27,798–27,870] |
| tool calls | 11 [9–12] | 1 [1–1] |
| execs | 1.0 [1.0–1.0] | 1.0 [1.0–1.0] |
| diag_reach | 3/3 | 3/3 |

**Verdict on the prediction** (`H4 <negative-cells>`): supported. The diagnostic was one window
away, so bgrun bought nothing here — it was *slower* (non-overlapping wall ranges), cost 12% more
context, and had identical executions — while doing precisely what it promises on the one axis it
owns: `blocked_s` 0.0 against 22.5. The unblocking was paid for in agent turns (9–12
`bgtail`/`bggrep` windows versus vanilla's single call), so `idle_s` on the bgrun side is the
job's runtime plus polling, not dead time.

`cause_reached` came out 3/3 in both arms — degenerate on this fixture, where the trace's only
file is the failing test that every session names. The column is informative only under
`DUMMY_CAUSE_MODULE=1`, i.e. the `trace-root` cell. n=3 per arm: spreads are reported, and no
significance is claimed.

### Cell 1b — the same cell after the no-poll change (2026-09-28)

Cell 1's mechanism was fixed in the extension and the cell re-run, with the fixture, model, prompt
and command held fixed — the only difference is the tool code (bench `8750f0e`, extension sha
`18f022248c9f4552`; product branch `fix/no-poll-before-wake`, commit `5e43fba`, against Cell 1's
`b6539e3fab30bb99`). Full record and artifacts:
[runs/red-tail-short-fixed/CELL.md](runs/red-tail-short-fixed/CELL.md).

| metric | Cell 1 | Cell 1b | vanilla (control) |
|---|---|---|---|
| wake claims before exit | 1, 2, 1 | **0, 0, 0** | — |
| polls before exit | 10, 9, 5 | **0, 0, 0** | — |
| tool calls per session | 12, 11, 9 | **2, 2, 2** | 1 |
| ctx_chars (median) | 31,170 | **9,892** | 27,817 → 28,021 |
| wall_s (median [min–max]) | 45.4 [42.9–51.1] | 40.9 [38.1–42.7] | 33.0 → 33.5 |
| blocked_s / diag_reach | 0.0, 3/3 | 0.0, 3/3 | 22.5, 3/3 |

**`H12` supported and fixed:** no session claims a wake it has not received, and the polls it
licensed went to zero. The interaction is now `bgrun` → yield → wake → one search → answer. Context
inverted — bgrun costs *less* than vanilla here — because with the log unavailable before the wake
the session searched it (`bggrep`, `locate` flipping from `position` to `pattern`) instead of
reading it in pieces. Wall time did **not** invert: the cell stays negative, exactly as the floor
argument predicted, because the job is 23.2s and the wake lands ~7s after it exits.

## Cell 3 — `trace-root`, measured 2026-09-28

Six sessions on the fixed extension (bench `8750f0e`), same fixture sha `605aba38baf5c6ad`. Full
record: [runs/trace-root/CELL.md](runs/trace-root/CELL.md).

| metric (median) | bgrun | vanilla |
|---|---|---|
| wall_s | 37.5 [37.1–39.5] | 34.5 [34.4–36.2] |
| blocked_s | 0.0 | 22.6 |
| ctx_chars | **9,758** | 28,271 |
| calls | 2 | 1 |
| `harness.ts` in context | **0, 0, 0** | **2, 2, 2** |
| deepest frame seen | `part-02.test.ts` | `harness.ts` |
| diag_reach | 3/3 | 3/3 |

**The bgrun arm never saw the cause.** The fixture puts it in a file of its own; vanilla's single
synchronous read carries the whole log and names it (*"Assertion error in `harness.ts:28`"*), while
the bgrun arm's pattern search — for failure words, which the frame line
`at loadStep (.../harness.ts:28:9)` does not contain — filtered it out, because the wake presented
its summary as the result ("the exit code, stats and last output above **are the result**"), leaving
no reason to open the window around the failure. That is the cell's prediction confirmed by its
intended mechanism, with the loss coming from the session's own grep rather than from condensation
(`H10` stays falsified).

**The efficiency result is real and it was bought with the diagnosis:** 65% less context and 3s more
wall, on a cell whose whole point is following the symptom to the root. `H9 <digest-starves>` gains
nothing from this cell: no digest was configured for this project, so it cannot speak to it. H9's one
behavioural entry remains the pilot cell's, where a configured digest carried counts and nothing
else. `H11` is **not** tested here: `cause_reached` reads 1
in both arms for definitional reasons (it is session-relative — the deepest frame *that session saw*),
so it must be read with `cause_file`; on a fixture with a separate cause file, the informative
question is whether that file appears at all, and it appeared 0/3 against 3/3. The ladder is what
would test `H11`, and a weak rung on the vanilla arm would still see `harness.ts` — a confound the
ladder will have to control for.

### Cell 3a — `trace-root` with the framing fix only (2026-09-28)

The same cell again, after the wake's closing line changed from "the exit code, stats and last output
above **are the result**" to "a summary, not the diagnosis — the log holds the detail, including the
context around any failure. For a failing job, read a window around the failure before concluding a
cause." Nothing else changed: no digest was configured for the project at all, so no preset and no
pointer were in play. Full record:
[runs/trace-root-framewake/CELL.md](runs/trace-root-framewake/CELL.md).

| metric | Cell 3 | Cell 3a |
|---|---|---|
| `harness.ts` in the bgrun arm's context | **0, 0, 0** | **3, 3, 5** |
| `cause_file` (deepest frame seen) | `part-02.test.ts` | **`harness.ts`** |
| tool calls | 2 | 3 |
| ctx_chars (median) | 9,758 | 14,009 |
| polls / wake claims | 0 / 0 | 0 / 0 |

**Two sentences of language-neutral framing fixed the cell** — "read a window around the failure"
knows nothing about how any runner spells a stack frame. The sequences show it: Cell 3's sessions ran
`bgrun` → `bggrep` and stopped at the symptom; Cell 3a's ran `bgrun` → `bggrep` → `bgtail`, reading
the window where the frames are. The extra call costs ~4k characters and buys the cause, still at
**half vanilla's context** (14,009 against 29,721); the wall floor stands (40.7s against 34.5s).

This also retroactively justifies deleting the built-in locator: the JS-tuned regex was never the fix.
The presets and the `on: "failure"` gate are precision layers — they put a pointer in the wake — not
the thing that made a session follow the trace. Variant B (`--variant tracepreset`) now measures an
increment on top of this rather than a fix.

## Cell 4 — `long-buried`, and its pointer variant (2026-09-28)

The expensive-workload cell: the failure is buried in `part-05` of ten, so a tail read has nothing to
find. Workload from the job's own command line: **570 tests, 1,281 lines, ~204s per run**. Full
record: [runs/long-buried/CELL.md](runs/long-buried/CELL.md).

| metric (median) | bgrun (framing only) | vanilla | bgrun (with pointer) |
|---|---|---|---|
| wall_s | **225.9** [223.1–228.4] | 696.2 [283.8–732.4] | 233.1 [231.2–233.1] |
| blocked_s | **0.0** | 660.2 | 0.0 |
| ctx_chars | **18,760** | 79,901 | 28,633 |
| calls | 3, 4, 4 | 12, 2, 6 | 5, 5, 6 |
| deepest frame seen | `part-05.test.ts` | `part-05.test.ts` | `part-05.test.ts` |
| polls / wake claims | 0 / 0 | — | 0 / 0 |

**The first cell where bgrun wins on both axes — 3.1× faster, 4.3× lighter — and the mechanism is the
job's cost.** bgrun pays it once (225.9s ≈ 204s job + ~22s agent work, `blocked_s` 0.0); vanilla pays
it repeatedly (4 foreground runs median, `blocked_s` 660.2, spread 283.8–732.4 depending on how many
times the session chose to re-run). This is the regime the async handoff is for, and it is the
counterweight to Cells 1/1b/3, where a 23–34s job made the wake's round trip the dominant cost.
Diagnosis is a *tie* — both arms reached `part-05.test.ts` — which is the best form of the result:
the same answer at a quarter of the context, because vanilla bought it by reading everything.

**The pointer variant is a negative result, and a product defect.** Its first behavioural exercise:
the `js-trace` preset fired on the failing job and named
`Failure: (pass) preset js-trace corpus (captured): …` — a **passing** test's name, not the failing
one. The cause is self-reference: the suite under test contains the preset's own corpus tests, which
print captured failure text, so the log holds failure-shaped strings from passing tests. Sessions did
not trust it — calls rose from 3–4 to 5–6, context ~50% — and still reached `part-05.test.ts`. The
scan cost is irrelevant (~20ms against 204s); the price is that a claim which may be wrong must be
verified.

**Design rule, now measured twice: a pointer is a hypothesis the session must still verify, and where
it can search cheaply that costs more than it saves.** A third run — the preset *fixed* to require real
evidence, after which every wake named the true failure
(`AssertionError … at /private/tmp/long-buried-fixture/part-05.test.ts:59:9`) — cost the *most*: calls
5, 5, 8 and context 33,799 [29,180–36,355], against 3, 4, 4 and 18,760 for no pointer at all. Calls
and context are non-overlapping between the baseline and both pointer variants. The sessions verified
the pointer and searched anyway (`bgrun bggrep bggrep bgtail bggrep`), because the wake's honest hedge
— "any failure named here is one failure, not the whole story" — makes it a lead rather than an answer.
The pointer's value should therefore be conditional on the session lacking a cheap search: a log too
large or hostile to grep, a tool-less agent, or a weaker model (what `H7`/`H8` would test). The
wrong-pointer run's number for comparison: 4 calls / 18.8k with none, 5.3 / 28.6k with a wrong one,
5.7 / 33.8k with a correct one. The preset defect itself is fixed from the kept log; the design rule is
what the three-way shows. Attribution caveat: the workload is the
extension's own suite, which is a pathological digest input, so the *rule* generalises further than
the *number* does.

## Blocked on

- Phase 1 instrument work is closed: `locating`, the shape and evidence-path instruments,
  and the unattended question (`H6`, negative — see above) are all answered. The first cell
  has since been measured ([Cell 1](#cell-1--red-tail-short-measured-2026-09-28)); what
  remains is `long-buried`, `trace-root`, and the ladder rungs above the mid rung — each
  needs its own attended sessions.
- The fixture's crutch is now a knob, not a blocker: `DUMMY_ANNOUNCE_FAILURE=0` removes
  the line that names the planted failure, and every diagnosis or discovery cell must run
  with it off. The default stays `1` so the measurements already taken against this
  fixture remain comparable.

## Instrument work, 2026-09-26 (no cell run)

Done while the cells wait on attended sessions. None of it is a measurement, and nothing
here is cited as evidence — it is the machinery the remaining cells need, built and verified.

- **`cause_reached` / `frames_opened`** in `scripts/measure-sessions.ts`, plus a `cause`
  column and three CSV columns. Frames are read from **tool results** — what a session could
  follow — not from its final answer; the cause is the deepest frame's file, and "reached"
  means some call addressed that file or the final text named it. A `trace-root` cell had no
  metric before this: `locating` measures how a session looked, and `H11` is about what it
  did with what it found.
- **`DUMMY_CAUSE_MODULE=1`** in `scripts/make-dummy-suite.ts`. The inline fixture could not
  answer the question at all: its trace's only *file* frame is the failing test itself and
  its second frame is the runner's own call site, so "open the file the trace names" was the
  same as reading the failing test. The knob moves the assertion into a helper module, so the
  deepest frame names `harness.ts` — a file with no other reason to be opened. Off by
  default, so the shapes already measured stay comparable.
- **A correction.** `method.md`'s `trace-root` row claimed the generated trace already named
  a cause frame; it did not. The row now names the knob the cell needs and both runners'
  second-frame shapes (Node `at …:39:25` above `at fn (node:test:210:18)`; Bun
  `TestContext.<anonymous>`).
- **Fixtures generated and shape-verified.** `trace-root`: 97 lines, exit 1, planted block and
  the runner's real trace both naming `harness.ts:28` and `part-02.test.ts:41`. `long-buried`:
  see [runs/long-buried/RUNSHEET.md](runs/long-buried/RUNSHEET.md).
- **Contracts covered:** the generator's shape (`scripts/make-dummy-suite.test.ts` — module
  present, both line numbers real, the run fails, the knob is opt-in, a bad value is
  rejected) and the metric's cases (`scripts/measure-sessions.test.ts` — reached by reading,
  missed by reading the failing test alone, reached by naming it, no trace at all, and the
  CSV header and row staying in step).

## What was discarded

An earlier round of measurements was withdrawn from these docs: cells were run while
the repository and fixture were being edited, the pty/pipe context was never recorded,
live and one-shot sessions were mixed without being labelled, and the figures could
not be traced to transcripts. None of its numbers are carried forward, and none are
cited as prior evidence here. The method above is what replaced it.
