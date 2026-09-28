# Run sheet — `long-buried`, second cell (2026-09-26)

Six sessions: three with bgrun available, three without. Same command, same neutral
prompt, one session directory per run. Cell definition and fixture recipe:
[../../method.md](../../method.md); prediction and ladder reading:
[../../predictions.md](../../predictions.md).

## Fixed for every run

| field | value |
|---|---|
| prompt | `Run bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/long-buried-fixture in this repo and report the failure details.` |
| fixture | `/private/tmp/long-buried-fixture` — 10 files, 300 tests, fails at part 05 step 15, exit 1; default knobs (`DUMMY_SLEEP_MS=600`, `DUMMY_LINES_PER_TEST=2`, `DUMMY_FAIL_FAST=0`), `DUMMY_ANNOUNCE_FAILURE=0` |
| fixture sha | `6671002e6f186546` (sorted file contents, concatenated, sha1, first 16 hex) |
| model | `anthropic/claude-sonnet-4-6` |
| working dir | `/Users/lloyd.engebretsen/sk/pi-bgrun.bench-doc` |
| sessions | each run gets its **own** `--session-dir`: a shared one profiles only its first `*.jsonl` |

**Verified shape of the run** (the exact command above, run from this worktree's shell):
994 lines, exit 1. The planted block starts at line **607** — about 61% through the output —
and the runner's own assertion failure is the only `at TestContext` frame in the run. The
cause module is deliberately **off** here: diagnosis depth is `trace-root`'s axis, not this
one, and switching it on would change two variables at once. Nothing positional reaches the
failure: a 40-line tail ends ~350 lines past it, and a 20-line one never sees the runner's
own error either. The failure has to be *found* before it can be followed, which is `H7
<capability>`. `DUMMY_ANNOUNCE_FAILURE=0` keeps the fixture from naming its own failure — a
discovery cell must not be handed the answer. `DUMMY_FAIL_FAST=0`, so the suite keeps running
to the end after failing: ~180s of work a background job is supposed to absorb.

## The six sessions

| # | arm | `--session-dir` | `-n` | extra flag |
|---|---|---|---|---|
| 1 | bgrun | `/private/tmp/cells/long-buried/bgrun-1` | `lb-bgrun-1` | `-e ./extension/index.ts` |
| 2 | bgrun | `/private/tmp/cells/long-buried/bgrun-2` | `lb-bgrun-2` | `-e ./extension/index.ts` |
| 3 | bgrun | `/private/tmp/cells/long-buried/bgrun-3` | `lb-bgrun-3` | `-e ./extension/index.ts` |
| 4 | vanilla | `/private/tmp/cells/long-buried/vanilla-1` | `lb-vanilla-1` | — |
| 5 | vanilla | `/private/tmp/cells/long-buried/vanilla-2` | `lb-vanilla-2` | — |
| 6 | vanilla | `/private/tmp/cells/long-buried/vanilla-3` | `lb-vanilla-3` | — |

```sh
cd /Users/lloyd.engebretsen/sk/pi-bgrun.bench-doc
pi -ne -ns \
  -e /Users/lloyd.engebretsen/.pi/agent/npm/node_modules/@stablekernel/pi-bifrost/src/index.ts \
  -e ./extension/index.ts \
  --provider bifrost-openai --model anthropic/claude-sonnet-4-6 \
  --session-dir /private/tmp/cells/long-buried/bgrun-1 -n lb-bgrun-1 \
  "Run bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/long-buried-fixture in this repo and report the failure details."
```

For the vanilla arm, drop the `-e ./extension/index.ts` line and change the session dir and
name. Quit gracefully (`/quit`, or ctrl+d) once the failure has been reported: a session
killed mid-turn writes no transcript, and the transcript is the measurement.

## What this cell is judged on

Wall time, `executions` (`1` vs the full runtime, once or twice), `handoffs` and
`blockedSeconds`, with the **context** columns read both ways — and the `locating` mix, since
`H7` predicts a rung difference in *how* the agent looks: pattern-search pins a failure buried
at 61% in one cheap call, while windowing it has to guess. Prediction: bgrun wins executions
and blocked time; context may go either way. Falsified by a positional strategy that reaches
the buried failure without a search, or by bgrun paying more context for the same
information.

## Premise note (2026-09-28, before these runs)

This cell was designed around a failure no positional window reaches. As of the wake change, the
bgrun arm is **handed** the first failure and its deepest frame in the wake, while the vanilla arm
still has to find it somewhere in ~994 lines. So the cell now measures *who hands you the failure*
rather than *whether a buried failure can be found*, and its pre-fix bgrun baseline is unmeasured —
these runs are on the fixed extension, as Cell 3's were. If the bgrun arm's advantage here looks
larger than `H7` predicted, the credit belongs to the pointer, not to the job mechanics.

## While the cell runs

- Nothing else heavy on the machine; I stay off it. **This cell is the one where that
  matters most**: the suite is 180s of real sleeping, so host load lands directly in the
  wall-clock numbers.
- No edits to the repo or the fixture mid-cell.
- One session at a time.

## Variant runs

**The pointer variant runs one arm, on purpose.** The question is whether the wake's pointer changes
the *bgrun* arm, so vanilla is not the control that matters here — and this cell's vanilla numbers
already exist (283.8–732.4s, three sessions) from the baseline above. Dropping it also drops the
interleaving, which the runner announces when it happens; that is acceptable in this cell because
bgrun's wall is 225.9s of which ~204s is the job itself, so drift lands on the ~22s remainder, and the
metrics of interest (calls, context) are job-independent. For a *new* fixture the other arm must stay:
it has no baseline yet.

```sh
./run-cell.sh long-buried --variant tracepreset-fixed --arms bgrun   # after the js-trace evidence fix
```

Name it something new each time: the runner refuses to write into a session dir that already has
transcripts, so a re-run cannot shadow the run it is compared against. That gives a three-way
comparison, each step changing one thing:

| run | pointer | calls (median) | ctx_chars (median) |
|---|---|---|---|
| `long-buried` | none (no digest configured) | 4 | 18,760 |
| `long-buried-tracepreset` | wrong (named a passing test) | 5 | 28,633 |
| `long-buried-tracepreset-fixed` | fixed (or silent) | — | — |

Outcomes, all informative: calls and context drop (the pointer earns its place); the preset emits
nothing and the arm matches the baseline (silence working as designed); or it still costs more (the
pointer's value is genuinely low in this regime rather than mis-tuned).

## After the six

I profile each transcript with `bun scripts/measure-sessions.ts <the files>`, write the
per-run table and manifest beside them under `.bench-runs/`, and record the cell's outcome
against its prediction in [../../results.md](../../results.md).
