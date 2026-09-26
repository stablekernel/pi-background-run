# Where the benchmark stands (2026-09-26)

**No cell has been run.** All three H7 cells are staged and waiting on attended sessions —
`H6` is negative (a detached job's session exits before its job finishes), so the sessions
are yours. Everything that could be built and verified without a session is built, verified
and committed.

## Your part

Each cell is six sessions: three with bgrun, three without, one session directory per run,
quit gracefully afterwards (`/quit` — a session killed mid-turn writes no transcript, and
the transcript *is* the measurement). Each run sheet is self-contained:

| cell | fixture | cost per run |
|---|---|---|
| [red-tail-short](runs/red-tail-short/RUNSHEET.md) | `/private/tmp/red-tail-fixture` (ready) | ~30s |
| [trace-root](runs/trace-root/RUNSHEET.md) | `/private/tmp/trace-root-fixture` (ready) | ~30s |
| [long-buried](runs/long-buried/RUNSHEET.md) | `/private/tmp/long-buried-fixture` (ready) | ~180s |

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

Committed: `a60cd7b` (metric, fixture knob, tests, the `trace-root` sheet).
