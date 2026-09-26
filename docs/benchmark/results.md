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
`/Users/lloyd.engebretsen/sk/pi-bgrun.ptyshape` at `8e63fc8`, then re-run in both
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

**Still open**: whether a pty whose input is held open by a FIFO writer (rather than
`/dev/null`) keeps `pi` alive past its turn.

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
| mid | `anthropic/claude-sonnet-4-6` | not run | not run | not run |
| strong | `anthropic/claude-opus-5` | not run | not run | not run |
| floor probe (not a rung) | `fireworks/gpt-oss-120b` | not run | not run | not run |

## Blocked on

- Phase 1 instrument work: `locating` and the shape/evidence-path instruments are done;
  the unattended-session smoke is running, and the unattended-versus-manual equivalence
  check needs two short manual sessions.
- The fixture's crutch is now a knob, not a blocker: `DUMMY_ANNOUNCE_FAILURE=0` removes
  the line that names the planted failure, and every diagnosis or discovery cell must run
  with it off. The default stays `1` so the measurements already taken against this
  fixture remain comparable.

## What was discarded

An earlier round of measurements was withdrawn from these docs: cells were run while
the repository and fixture were being edited, the pty/pipe context was never recorded,
live and one-shot sessions were mixed without being labelled, and the figures could
not be traced to transcripts. None of its numbers are carried forward, and none are
cited as prior evidence here. The method above is what replaced it.
