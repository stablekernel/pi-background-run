# Cell 3 — `trace-root`, measured 2026-09-28

Six sessions, three per arm, one session directory each, interleaved. Run sheet:
[RUNSHEET.md](RUNSHEET.md). Prediction: [../../predictions.md](../../predictions.md) (`H11`, and
the cell-register row that expects bgrun to struggle here).

| field | value |
|---|---|
| extension | the fixed one: bench commit `d948560`, sha `18f022248c9f4552` |
| fixture | `/private/tmp/trace-root-fixture`, sha `605aba38baf5c6ad` — the failing test calls a helper **module**, so the trace's deepest frame names `harness.ts`, a file with no other reason to be opened |
| prompt | the neutral prompt in the run sheet, unmodified |
| profile | [profile.txt](profile.txt), [profile.csv](profile.csv), [wake-claims.csv](wake-claims.csv) |

## Result

| # | arm | execs | wall_s | blocked_s | ctx_chars | calls | locate | cause_reached | cause_file (deepest frame **seen**) |
|---|---|---|---|---|---|---|---|---|---|
| bgrun-1 | bgrun | 1 | 37.5 | 0.0 | 9,758 | 2 | pattern | 1 | `part-02.test.ts` |
| bgrun-2 | bgrun | 1 | 37.1 | 0.0 | 9,757 | 2 | pattern | 1 | `part-02.test.ts` |
| bgrun-3 | bgrun | 1 | 39.5 | 0.0 | 10,061 | 2 | pattern | 1 | `part-02.test.ts` |
| vanilla-1 | vanilla | 1 | 34.5 | 22.6 | 28,271 | 1 | full-read | 1 | `harness.ts` |
| vanilla-2 | vanilla | 1 | 34.4 | 22.8 | 28,248 | 1 | full-read | 1 | `harness.ts` |
| vanilla-3 | vanilla | 1 | 36.2 | 22.5 | 28,379 | 1 | full-read | 1 | `harness.ts` |

Medians: bgrun 37.5s [37.1–39.5] / 9,758 chars; vanilla 34.5s [34.4–36.2] / 28,271 chars.
`diag_reach` 3/3 both arms; `execs` 1 everywhere; no session ran the suite twice.

## The finding: the bgrun arm never saw the cause

The fixture puts the cause in a file of its own. Measured over the whole transcripts:

| arm | `harness.ts` occurrences in context | deepest frame seen |
|---|---|---|
| bgrun, x3 | **0, 0, 0** | `part-02.test.ts` |
| vanilla, x3 | **2, 2, 2** | `harness.ts` |

Vanilla's single synchronous read carries the whole log, so the cause frame comes with it — one
session names it outright: *"Assertion error in `harness.ts:28`"*. The bgrun arm's view, built from
a **pattern search** over the log after the wake, does not contain it: the sessions searched for
failure words (`(?i)(fail|✗|×|error|expect)`), which matches the assertion and the runner's `(fail)`
line but **not** the frame lines themselves — `at loadStep (.../harness.ts:28:9)` contains no failure
word. So the frame was filtered out by the search — and the reason there was a search at all is the
wake's framing: it closed with *"the exit code, stats and last output above **are the result**"*, so
the session had no reason to open the window around the failure and reached for the failure words it
could see. No digest was configured for this project — unlike the pilot cell, which ran in the product
repo where one is — so the wake carried no digest block at all; what starved this session was the
summary framing, not a missing capability — and that is exactly what Cell 3a tests, by changing the
framing alone. The bgrun answers cite `part-02.test.ts` with line numbers that actually belong to the
harness file (28 is the assertion inside `harness.ts`, 41 the call site): numbers without their file
attribution. How those numbers reached a context with no `harness.ts` in it is not established from
these transcripts and is left as an open question rather than a story.

That is the mechanism this cell was built to expose — *"every layer that summarises between the
session and the log is a way to lose that frame"* — except the layer that lost it here is the
session's own grep, chosen because the wake presented a summary as the result.

## What this says about cost and about `H9`

- **The efficiency result is real and large:** 9,758 characters against vanilla's 28,271, i.e. the
  bgrun arm paid 65% *less* context — and 3s *more* wall (37.5 vs 34.5), since the job plus the
  wake's delay is the floor.
- **And it bought that with the diagnosis.** Both arms reach the symptom; only vanilla reaches the
  file the cause lives in. On this cell the tool's saving and its blind spot are the same
  mechanism.
- **`H9 <digest-starves>` gains nothing from this cell:** no digest was configured for this project,
  so the wake carried no digest block and the cell cannot speak to it. H9's one behavioural entry
  remains the pilot cell's, which did run with a digest configured (counts only).

## `H11` is *not* tested by this cell, and the metric needs reading in pairs

`cause_reached` reads **1 for every session in both arms**, which is exactly the "flat" result
`H11` predicts for a rung difference — but it is flat for a definitional reason, not a behavioural
one: the metric defines the cause as *the deepest frame this session saw*, which is session-relative.
For bgrun that is the failing test; for vanilla it is `harness.ts`. Each arm reached the deepest file
it was shown, so the flag cannot distinguish them. **Read `cause_file` with `cause_reached`.** On a
fixture whose cause is a separate file, the informative question is whether that file appeared at
all, and here it did so 0/3 against 3/3.

`H11`'s actual claim — capability, not reading strategy — needs the rungs
([../../predictions.md](../../predictions.md), the ladder table), which this cell has not run. What
this cell shows is that on the bgrun side an *instrument* difference can produce the appearance of a
depth difference, which is a confound the ladder will have to control for: a weak rung on the vanilla
arm would still see `harness.ts`, because the whole log arrives in one result.

## Also measured: the no-poll fix holds on a second cell

Two calls per bgrun session (`bgrun`, then one `bggrep` after the wake), zero polls before the wake,
zero wake claims (0/3 again), `blocked_s` 0.0. See [wake-claims.csv](wake-claims.csv).

This cell ran on the **fixed** extension, so the pre-fix behaviour of `trace-root` is unmeasured —
the fix's effect here is unknown, and what is recorded is the post-fix state.

## Limits

n=3 per arm, one model, one fixture, mid rung only. The cause-loss is a property of what the tools
put in front of the session, not of the model's diagnosis ability; `long-buried` remains, and it is
the cell where the gate's cost is highest.
