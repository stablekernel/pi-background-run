# Run sheet — `red-tail-short`, first cell (2026-09-26)

Six sessions: three with bgrun available, three without. Same command, same neutral
prompt, one session directory per run. Cell definition: [../../method.md](../../method.md);
prediction: [../../predictions.md](../../predictions.md).

## Fixed for every run

| field | value |
|---|---|
| prompt | `Run bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/red-tail-fixture in this repo and report the failure details.` |
| fixture | `/private/tmp/red-tail-fixture` — 2 files, 8 tests, fails at part 02 step 04, exit 1; `DUMMY_SLEEP_MS=1`, `DUMMY_ANNOUNCE_FAILURE=0` |
| fixture sha | `0bfe00ed1d9866b9` (recomputed 2026-09-28 under the method above; the earlier `9b42b1ea3d980ef6` was not reproducible — the files' mtimes and all six transcripts confirm the content was unchanged, see [CELL.md](CELL.md)) |
| model | `anthropic/claude-sonnet-4-6` |
| working dir | `~/sk/pi-bgrun.bench-doc` |
| sessions | each run gets its **own** `--session-dir`: a shared one profiles only its first `*.jsonl` |

**Verified shape of the run** (agent environment, the command above): 96 lines, exit 1,
9 frame lines, failure block at lines 72–76 — about 75% through the output rather than at
the tail. A 40-line tail reaches it; a 20-line one does not. That is the cell: the
diagnostic is positionally reachable in one window, which is where bgrun is predicted to
buy nothing (`H4 <negative-cells>`). The prompt says nothing about how to run it — whether
a session reaches for bgrun is the finding, not the instruction.

## The six sessions

| # | arm | `--session-dir` | `-n` | extra flag |
|---|---|---|---|---|
| 1 | bgrun | `/private/tmp/cells/red-tail-short/bgrun-1` | `rt-bgrun-1` | `-e ./extension/index.ts` |
| 2 | bgrun | `/private/tmp/cells/red-tail-short/bgrun-2` | `rt-bgrun-2` | `-e ./extension/index.ts` |
| 3 | bgrun | `/private/tmp/cells/red-tail-short/bgrun-3` | `rt-bgrun-3` | `-e ./extension/index.ts` |
| 4 | vanilla | `/private/tmp/cells/red-tail-short/vanilla-1` | `rt-vanilla-1` | — |
| 5 | vanilla | `/private/tmp/cells/red-tail-short/vanilla-2` | `rt-vanilla-2` | — |
| 6 | vanilla | `/private/tmp/cells/red-tail-short/vanilla-3` | `rt-vanilla-3` | — |

```sh
cd ~/sk/pi-bgrun.bench-doc
pi -ne -ns \
  -e ~/.pi/agent/npm/node_modules/@stablekernel/pi-bifrost/src/index.ts \
  -e ./extension/index.ts \
  --provider bifrost-openai --model anthropic/claude-sonnet-4-6 \
  --session-dir /private/tmp/cells/red-tail-short/bgrun-1 -n rt-bgrun-1 \
  "Run bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/red-tail-fixture in this repo and report the failure details."
```

For the vanilla arm, drop the `-e ./extension/index.ts` line and change the session dir and
name. Quit gracefully (`/quit`, or ctrl+d) once the failure has been reported: a session
killed mid-turn writes no transcript, and the transcript is the measurement.

## While the cell runs

- Nothing else heavy on the machine; I stay off it.
- No edits to the repo or the fixture mid-cell.
- One session at a time.

## After the six

I profile each transcript with `bun scripts/measure-sessions.ts <the files>`, write the
per-run table and manifest beside them under `.bench-runs/`, and record the cell's outcome
against its prediction in [../../results.md](../../results.md).
