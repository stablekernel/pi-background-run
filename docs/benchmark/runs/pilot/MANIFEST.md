# Pilot — the attended method, end to end (2026-09-26)

Not a battery cell. This is the method check `H6 <unattended>` could not be: two
human-driven sessions on one fixture, confirming that a bgrun job's wake lands in a live
session and that the session can act on it. `H6` itself is negative on this setup — a
detached job's stdin is `/dev/null`, so the session exits before its own job finishes (see
[../../results.md](../../results.md)).

| field | value |
|---|---|
| fixture | `/private/tmp/equiv-fixture` — 2 files, 12 tests, fails at part 02 step 04, exit 1; `DUMMY_SLEEP_MS=50`, `DUMMY_ANNOUNCE_FAILURE=0` |
| fixture sha | `8bf97128414cba0b` |
| arm | `bgrun` (this repo's extension, `-e ./extension/index.ts`) |
| model | `anthropic/claude-haiku-4-5` |
| context | `live` — a human in the session, which is the point |
| config | none: this worktree has no `.pi/pi-bgrun.json`, so no digest and the default jobs dir |
| capture | the agent's own terminal; transcripts written to `--session-dir` |
| prompt | `Run 'bun test /private/tmp/equiv-fixture' in this repo as a background job with bgrun, and report the failure details once it finishes.` |
| profiler | `bun scripts/measure-sessions.ts <each transcript file>` — **pass the files**: a directory target profiles only its first `*.jsonl` |
| transcripts | `.bench-runs/pilot/` (scratch, git-ignored — raw session JSONL is evidence, not documentation; whether it belongs in the repo is a later decision). The table below names them relative to that directory |

The prompt above names bgrun, which is fine for a *method* check and wrong for a *cell*:
cells use the neutral ask, so that whether a session reaches for the tool is a finding
rather than an instruction.

## Runs

| session | transcript | job | execs | handoff | fg | blocked_s | wall_s | ctx_chars | diag | locate | calls |
|---|---|---|---|---|---|---|---|---|---|---|---|
| manual-1 | `manual-1.jsonl` | `equiv-fixture-test-1790397978-60765` | 1 | 1 | 0 | 0.0 | 8.3 | 3,903 | up+down | `position` | 2 |
| manual-2 | `manual-2.jsonl` | `bun-test-equiv-fixture-1790398022-63481` | 1 | 1 | 0 | 0.0 | 8.3 | 4,427 | up+down | `position` | 2 |

## What it establishes

- **The wake lands and is acted on**: 2/2. Both markers reached the final assistant text,
  each session made one `bgtail` call on the job's log, and neither ran the suite in the
  foreground (`fg` 0, `blocked_s` 0.0).
- **The instrument is usable as a method**: wall identical to the tenth (8.3s), execution
  counts identical, context within 13% between runs — the repeatability a battery needs
  before a cell's numbers mean anything.
- **It found a trap, which is what an instrument check is for**: the profiler's directory
  target is *one* session (its first `*.jsonl`, sorted). A flat shared session dir
  therefore profiled one run and silently dropped the other.

**The two manual pilot transcripts are not in this repository.** They were committed once and
later removed, and because a removed file stays in git history while remaining fetchable, both
were purged from this branch's history on 2026-09-28 (rewrite of `bench/dogfooding`, unpushed,
so no published history changed). The rows above are kept as the pilot's record; the transcripts
themselves survive outside any repository. Their numbers were never used in `results.md`.
