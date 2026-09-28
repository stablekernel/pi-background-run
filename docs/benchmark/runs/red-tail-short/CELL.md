# Cell 1 — `red-tail-short`, measured 2026-09-28

Six sessions, three per arm, one session directory each, interleaved bgrun/vanilla.
Run sheet: [RUNSHEET.md](RUNSHEET.md). Cell definition: [../../method.md](../../method.md).
Prediction: [../../predictions.md](../../predictions.md) (`H4 <negative-cells>`).

| field | value |
|---|---|
| model | `anthropic/claude-sonnet-4-6` |
| fixture | `/private/tmp/red-tail-fixture` — files dated 2026-09-26 00:51, i.e. generated once and never rewritten since, so these runs measured the original bytes |
| prompt | the neutral prompt in the run sheet, unmodified, nothing added in any session |
| transcripts | `/private/tmp/cells/red-tail-short/<arm>-<n>/`; session ids are in `profile.csv` |
| profile | [profile.txt](profile.txt), [profile.csv](profile.csv) |

## Result

| # | arm | execs | fg | handoff | wall_s | blocked_s | idle_s | ctx_chars | diag | locate | cause | calls |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bgrun-1 | bgrun | 1 | 0 | 1 | 42.9 | 0.0 | 42.9 | 31,170 | up+down | position | reached | 12 |
| bgrun-2 | bgrun | 1 | 0 | 1 | 45.4 | 0.0 | 45.4 | 31,782 | up+down | position | reached | 11 |
| bgrun-3 | bgrun | 1 | 0 | 1 | 51.1 | 0.0 | 51.1 | 29,403 | up+down | position | reached | 9 |
| vanilla-1 | vanilla | 1 | 1 | 0 | 33.0 | 22.5 | 10.5 | 27,798 | up+down | position | reached | 1 |
| vanilla-2 | vanilla | 1 | 1 | 0 | 32.5 | 22.6 | 9.9 | 27,817 | up+down | position | reached | 1 |
| vanilla-3 | vanilla | 1 | 1 | 0 | 38.2 | 22.5 | 15.8 | 27,870 | up+down | position | reached | 1 |

Median `[min–max]` per arm:

| metric | bgrun | vanilla |
|---|---|---|
| wall_s | 45.4 [42.9–51.1] | 33.0 [32.5–38.2] |
| blocked_s | 0.0 [0.0–0.0] | 22.5 [22.5–22.6] |
| idle_s | 45.4 [42.9–51.1] | 10.5 [9.9–15.8] |
| ctx_chars | 31,170 [29,403–31,782] | 27,817 [27,798–27,870] |
| tool calls | 11 [9–12] | 1 [1–1] |
| execs | 1.0 [1.0–1.0] | 1.0 [1.0–1.0] |
| diag_reach | 3/3 | 3/3 |

## Against the prediction

Predicted: the diagnostic is positionally reachable in one window, so **bgrun buys nothing on
this cell**. Supported, and then some:

- **Wall: bgrun is slower** — 45.4s vs 33.0s median, and the ranges do not overlap (42.9–51.1
  vs 32.5–38.2).
- **Context: bgrun costs more** — 31,170 vs 27,817 chars (+12%), ranges likewise separate.
- **Executions: 1 in every session, both arms.** Nobody re-ran the suite; one run's output held
  the failure. That is what this cell was built to check.
- **The one structural win, exactly as designed:** `blocked_s` 0.0 vs 22.5. bgrun never blocks.
- **`diag_reach` 3/3 both arms** — no session lost the failure detail, so this cell says nothing
  about reach, only about cost.

**Mechanism, visible in the ledgers:** the bgrun arm paid for the unblocking in *agent turns* —
9–12 tool calls against vanilla's 1, all of them `bgtail`/`bggrep` windows with 0.0s waits,
dripping the log out in pieces while the job ran. bgrun's own description says not to poll a job
you just started; all three sessions did. So the 42.9–51.1s "idle" is not dead time — it is the
job's runtime plus the polling that replaced blocking, which is exactly why `idle_s` is not
comparable across arms.

**`locate`:** the first move was `position` in all six. `pattern` (`bggrep`) appears only on the
bgrun side — bgrun-3 used it five times — which is the greppable log showing up as an affordance.
n=1, so no claim about `H7` from this cell.

**`cause_reached` is degenerate here:** 3/3 both arms. On this fixture the trace's only file is
the failing test, and every session named it. The column earns its keep only under
`DUMMY_CAUSE_MODULE=1` — the `trace-root` cell.

## Instrument notes (recorded, not quietly fixed)

- **A profiler bug this cell caught.** bgrun-3 first profiled as `cause = -` (no trace at all)
  while its transcript held five frame lines: it read the log through a line-numbered view
  (`L331:       at …/part-02.test.ts:58:18`) and the frame pattern was anchored on `^\s*at`. The
  pattern now tolerates `L<n>:`/`<n>:` prefixes, with both spellings pinned in
  `scripts/measure-sessions.test.ts`. Every number above is from the fixed profiler. It is
  recorded because the same bug would have understated precisely the column `trace-root` reads.
- **The sheet's shape figures are one revision stale.** They were measured before this cell's
  run, and `scripts/measure-sessions.test.ts` gained a test in between, which lengthened the
  repo suite's share of the combined output: 95 lines now, planted block at line 70, against the
  sheet's 96 / 72–76. The *fixture's* shape is unchanged, and all six transcripts carry
  `load part 02 > step 04`, the downstream marker and 3 distinct frames. The sheet has been
  corrected with the same note.
- **Fixture sha.** The sheet's `9b42b1ea3d980ef6` is not reproducible under the stated method
  (sorted file contents, concatenated, sha1, first 16 hex), which now yields
  `0bfe00ed1d9866b9`. The files' mtimes (2026-09-26 00:51) and the transcripts both confirm the
  content is the original, so this is a method mismatch in the earlier session's record, not a
  changed fixture. The sheet now carries the reproducible value.
