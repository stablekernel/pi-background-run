# Where the benchmark stands (2026-09-26)

**No cell has been run.** All three H7 cells are staged and waiting on attended sessions —
`H6` is negative (a detached job's session exits before its job finishes), so the sessions
are yours. Everything that could be built and verified without a session is built, verified
and committed.

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

Committed: `a60cd7b` (metric, fixture knob, tests, the `trace-root` sheet) and `6f7d6d1` (the
three sheets, the corrected rows, the dated instrument entry).

## One decision waiting for you

The raw session transcripts should be **kept, not left in `/tmp`**. An earlier round of
measurements was withdrawn from these docs for a reason that still bites — figures that could
not be traced back to transcripts. The profiles (`--csv`) and the per-run manifests get
committed beside each cell's run sheet; the transcripts are the evidence those numbers refer
to, and they are text, so keeping them is cheap. `.bench-runs/` stays the scratch for working
output, which is what it is for.
