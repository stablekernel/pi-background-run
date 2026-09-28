# Run sheet — `trace-root`, third cell (2026-09-26)

Six sessions: three with bgrun available, three without. Same command, same neutral
prompt, one session directory per run. Cell definition and fixture recipe:
[../../method.md](../../method.md); prediction and ladder reading:
[../../predictions.md](../../predictions.md).

## Fixed for every run

| field | value |
|---|---|
| prompt | `Run bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/trace-root-fixture in this repo and report the failure details.` |
| fixture | `/private/tmp/trace-root-fixture` — 2 files, 8 tests, fails at part 02 step 04, exit 1; `DUMMY_SLEEP_MS=1`, `DUMMY_ANNOUNCE_FAILURE=0`, `DUMMY_CAUSE_MODULE=1` |
| fixture sha | `605aba38baf5c6ad` (sorted file contents, concatenated, sha1, first 16 hex) |
| model | `anthropic/claude-sonnet-4-6` |
| working dir | `/Users/lloyd.engebretsen/sk/pi-bgrun.bench-doc` |
| sessions | each run gets its **own** `--session-dir`: a shared one profiles only its first `*.jsonl` |

**Verified shape of the run** (the exact command above, run from this worktree's shell):
97 lines, exit 1. The planted block sits at lines 34–35 and names two files —
`harness.ts:28` (the assertion) then `part-02.test.ts:41` (the call site) — and the
runner's own trace at line 73 names the same two, with `(fail)` at 77. So the symptom and
the cause are in **different files**, and the cause's file is one the session has no other
reason to open: reading the failing test does not get you there. That is the cell. The
prompt says nothing about how to run it or how far to follow the trace — whether a session
reaches `harness.ts` at all is the finding, not the instruction.

The prompt is deliberately identical in form to `red-tail-short`'s, so the two cells differ
only in the fixture — diagnosis depth, not the command.

## The six sessions

| # | arm | `--session-dir` | `-n` | extra flag |
|---|---|---|---|---|
| 1 | bgrun | `/private/tmp/cells/trace-root/bgrun-1` | `tr-bgrun-1` | `-e ./extension/index.ts` |
| 2 | bgrun | `/private/tmp/cells/trace-root/bgrun-2` | `tr-bgrun-2` | `-e ./extension/index.ts` |
| 3 | bgrun | `/private/tmp/cells/trace-root/bgrun-3` | `tr-bgrun-3` | `-e ./extension/index.ts` |
| 4 | vanilla | `/private/tmp/cells/trace-root/vanilla-1` | `tr-vanilla-1` | — |
| 5 | vanilla | `/private/tmp/cells/trace-root/vanilla-2` | `tr-vanilla-2` | — |
| 6 | vanilla | `/private/tmp/cells/trace-root/vanilla-3` | `tr-vanilla-3` | — |

```sh
cd /Users/lloyd.engebretsen/sk/pi-bgrun.bench-doc
pi -ne -ns \
  -e /Users/lloyd.engebretsen/.pi/agent/npm/node_modules/@stablekernel/pi-bifrost/src/index.ts \
  -e ./extension/index.ts \
  --provider bifrost-openai --model anthropic/claude-sonnet-4-6 \
  --session-dir /private/tmp/cells/trace-root/bgrun-1 -n tr-bgrun-1 \
  "Run bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/trace-root-fixture in this repo and report the failure details."
```

For the vanilla arm, drop the `-e ./extension/index.ts` line and change the session dir and
name. Quit gracefully (`/quit`, or ctrl+d) once the failure has been reported: a session
killed mid-turn writes no transcript, and the transcript is the measurement.

## What this cell is judged on

`cause_reached` and `frames_opened`, **not** `locating`: H11 predicts a difference in what a
session does with what it found, not in how it looked ([../../predictions.md](../../predictions.md)).
Weak rungs report the assertion text and stop (`cause_reached` false); mid rungs open the
frame the trace names; strong rungs open it and name the reason. The cell leans vanilla on
paper — the symptom is one grep away, while the cause is a frame the session must open and
read — and the two mechanisms that could lose that frame on the bgrun side have already been
measured away as instrument checks: the wake digest (counts only, `H9`) and `bgtail`'s
condenser (kept every frame, `H10` falsified as stated). Falsified by a flat mix across rungs.

## Variant: a digest that names the failure (proposed experiment)

Cell 3's bgrun sessions never saw the cause file: the wake's digest is counts-only, so they had no
pointer and searched for failure words, which a frame line does not contain. Whether that pointer is
the whole story is testable without any product change — re-run this cell with a digest that names
the failure and see whether `harness.ts` appears:

1. In `.pi/pi-bgrun.json` (the bench worktree's project config), replace the `test` digest's
   `command` with something that keeps the failure and its neighbourhood:

   ```json
   "command": "grep -E '(fail|✗|AssertionError)' -A3 \"$1\" | tail -12"
   ```

2. Run the cell into fresh dirs, so it cannot shadow the runs above:

   ```sh
   ./run-cell.sh trace-root --variant namingdigest
   ```

3. Compare `harness.ts` occurrences in context and `cause_file` between `trace-root` and
   `trace-root-namingdigest`. If the cause file appears, the missing pointer was the whole defect and
   the fix belongs in the wake itself (name the deepest frame), not in each project's config.

Restore the config afterwards: a changed digest silently changes every later cell.

## While the cell runs

- Nothing else heavy on the machine; I stay off it.
- No edits to the repo or the fixture mid-cell.
- One session at a time.

## After the six

I profile each transcript with `bun scripts/measure-sessions.ts <the files>`, write the
per-run table and manifest beside them under `.bench-runs/`, and record the cell's outcome
against its prediction in [../../results.md](../../results.md). The metric this cell reads
(`cause_reached`, `frames_opened`, plus the `cause` table column) landed 2026-09-26 in
`scripts/measure-sessions.ts`, with the shape contract that makes it meaningful covered by
`scripts/make-dummy-suite.test.ts`.
