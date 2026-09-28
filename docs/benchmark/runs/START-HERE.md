# Where the benchmark stands (2026-09-28)

- **Cell 1 `red-tail-short`: measured.** Six sessions, artifacts committed behind
  [red-tail-short/CELL.md](red-tail-short/CELL.md) and recorded in [../results.md](../results.md).
- **The extension was then fixed.** Cell 1 showed every bgrun session polling a job it had just
  handed off, each asserting a wake it had not received; the tool now answers a still-running job
  with its state instead of its log, and `bgrun`'s handoff says the task is done at launch. The same
  cell was re-run: [red-tail-short-fixed/CELL.md](red-tail-short-fixed/CELL.md). Polls before the
  wake went 10/9/5 → 0/0/0, calls per session 12/11/9 → 2/2/2, context 31.2k → 9.9k — now *below*
  vanilla's 28k. Wall time stayed slower (40.9s vs 33.5s), exactly as the floor argument predicted.
  The product change is on branch `fix/no-poll-before-wake` (`5e43fba`) in the product repo.
- **Next: `trace-root`, then `long-buried`.** Both staged. The bench worktree already carries the
  fixed extension, so new cells run it with no flag; `--variant` exists only to re-run a cell that
  already has transcripts. `long-buried` is the one where mid-run waiting is a real strategy rather
  than a formality, so it is where the new gate costs the most; `trace-root` tests `H11` and makes
  `cause_reached` informative.

The cells still need attended sessions — `H6` is negative (a detached job's session exits before its
job finishes).

## Your part — one command

```sh
cd /Users/lloyd.engebretsen/sk/pi-bgrun.bench-doc/docs/benchmark/runs
./run-cell.sh red-tail-short              # six sessions, one at a time
./run-cell.sh red-tail-short --dry-run    # print the six commands, launch nothing
# then: ./run-cell.sh trace-root, ./run-cell.sh long-buried
```

Each run hands the terminal to `pi`; you drive the session and quit it with `/quit` once the
failure has been reported. The script does the rest: the banner and exact command, a per-run
**transcript check** (it stops rather than let a half-written session pass), a refusal to start
a run whose session dir already holds a transcript (the profiler reads the first `*.jsonl`, so
a stale one would shadow the new run), and the cell's profile at the end —
`.bench-runs/<cell>/profile.{txt,csv}`.

Runs are **interleaved** (`bgrun-1, vanilla-1, bgrun-2, …`): six sessions span roughly half an
hour, and interleaving puts any drift in host load or thermals on both arms instead of on
whichever arm ran last.

The run sheets below remain the record of what each cell fixes and what it is judged on:

| cell | fixture | cost per run |
|---|---|---|
| [red-tail-short](red-tail-short/RUNSHEET.md) | `/private/tmp/red-tail-fixture` (ready) | ~30s |
| [trace-root](trace-root/RUNSHEET.md) | `/private/tmp/trace-root-fixture` (ready) | ~30s |
| [long-buried](long-buried/RUNSHEET.md) | `/private/tmp/long-buried-fixture` (ready) | ~180s |

## Done in the meantime (no sessions needed)

- **`cause_reached` / `frames_opened`** in `scripts/measure-sessions.ts`, with a `cause`
  table column and three CSV columns. `trace-root` had no metric before this: `locating`
  measures how a session looked, `H11` asks what it did with what it found.
- **`DUMMY_CAUSE_MODULE=1`** in `scripts/make-dummy-suite.ts`: the failing test calls a
  helper module, so the trace's deepest frame names a file that is not the failing test.
  Without it there was no cause to follow — the inline trace names the failing test twice.
- **A correction:** `method.md`'s `trace-root` row claimed the generated trace already named
  a cause frame. It did not; its second frame is the runner's own call site. Fixed, with both
  runners' shapes recorded.
- **Fixture shapes verified:** `trace-root` (97 lines, exit 1, cause at `harness.ts:28`, call
  site at `part-02.test.ts:41`), `long-buried` (in its run sheet).
- **Contracts covered:** the generator's shape (`scripts/make-dummy-suite.test.ts`) and the
  metric's cases (`scripts/measure-sessions.test.ts`) — 23 tests, `tsc --noEmit` clean.

## After your sessions

```sh
cd /Users/lloyd.engebretsen/sk/pi-bgrun.bench-doc
bun scripts/measure-sessions.ts <the session dirs> --csv
```

One row per session. The profile then goes beside the transcripts under `.bench-runs/`, the
cell's outcome is recorded in `results.md` against its prediction, and that is also when the
write-up item can move.

Committed since this page was written: the metric and the fixture knob (`a60cd7b`), the three run
sheets (`6f7d6d1`), Cell 1's record (`6c71e15`), the mechanism findings and `H12` (`fbdba4b`), the
wake-claim instrument and cell variants (`3bf08bc`), the synced fix (`d948560`), and Cell 1b's
record with its before/after artifacts.

## One decision waiting for you

The raw session transcripts should be **kept, not left in `/tmp`**. An earlier round of
measurements was withdrawn from these docs for a reason that still bites — figures that could
not be traced back to transcripts. The profiles (`--csv`) and the per-run manifests get
committed beside each cell's run sheet; the transcripts are the evidence those numbers refer
to, and they are text, so keeping them is cheap. `.bench-runs/` stays the scratch for working
output, which is what it is for.
