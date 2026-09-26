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

Neither shape is ever larger. What changes the output is whether `AGENT` or
`CLAUDECODE` is set (either alone suffices) and whether `TERM` supports colour — not
whether stdout is a terminal. This is also the explanation for the earlier round's
unexplained line counts for one command: it was the environment, not the terminal.

**Provenance**: `bun scripts/pty-shape.ts`, run in
`/Users/lloyd.engebretsen/sk/pi-bgrun.ptyshape` at `8e63fc8`, then re-run in both
environments to confirm; `bun test scripts/pty-shape.test.ts` — 4 tests pass;
`tsc --noEmit` clean.

**Consequences**: `pty-agent` is dropped as void; the manifest records the environment;
no line count is quoted without one; the fixture's own line counts are re-measured per
environment before any cell depends on them.

## Capability ladder

Crossed with `red-tail-short` and `long-buried` only. Rungs to be named and probed for
availability before the battery starts.

| rung | model | `red-tail-short` | `long-buried` |
|---|---|---|---|
| weak | `anthropic/claude-haiku-4-5` | not run | not run |
| mid | `anthropic/claude-sonnet-4-6` | not run | not run |
| strong | `anthropic/claude-opus-5` | not run | not run |
| floor probe (not a rung) | `fireworks/gpt-oss-120b` | not run | not run |

## Blocked on

- Phase 1 instrument work: the `locating` classification in the profiler, `pty-shape.ts`
  and its CI test, fixture reproducibility, the unattended-session smoke, and the
  unattended-versus-manual equivalence check (which needs two short manual sessions).
- ~~Rung selection~~ **chosen**: the Claude family ladder above, every rung probed for
  availability. Remaining: the unattended-session smoke, and the equivalence check,
  which needs two short manual sessions.

## What was discarded

An earlier round of measurements was withdrawn from these docs: cells were run while
the repository and fixture were being edited, the pty/pipe context was never recorded,
live and one-shot sessions were mixed without being labelled, and the figures could
not be traced to transcripts. None of its numbers are carried forward, and none are
cited as prior evidence here. The method above is what replaced it.
