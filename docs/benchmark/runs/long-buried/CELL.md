# Cell 4 — `long-buried`, and its pointer variant (2026-09-28)

The expensive-workload cell: 10 fixture parts, the failure buried in `part-05` (the only part with a
real assertion cluster — 5 sites against 1 in every other part), so a tail read has nothing to find.
The cell's whole point is whether the interaction survives a log too large to skim.

Workload, from the job's own command line: `bun test extension/index.test.ts
scripts/measure-sessions.test.ts scripts/pty-shape.test.ts /private/tmp/long-buried-fixture` —
**570 tests, 1,281 lines, ~204s per run**. That number explains every figure below.

## Baseline — framing only, no digest configured

| # | arm | wall_s | blocked_s | ctx_chars | calls | locate | cause_file |
|---|---|---|---|---|---|---|---|
| bgrun-1..3 | bgrun | **225.9** [223.1–228.4] | **0.0** | **18,760** [16,365–21,056] | 3, 4, 4 | pattern | `part-05.test.ts` |
| vanilla-1..3 | vanilla | 696.2 [283.8–732.4] | 660.2 | 79,901 [66,792–86,836] | 12, 2, 6 | full-read | `part-05.test.ts` |

Artifacts: [profile.txt](profile.txt), [profile.csv](profile.csv), [wake-claims.csv](wake-claims.csv).

**The first cell where bgrun wins on both axes: 3.1× faster and 4.3× lighter.** The mechanism is the
job's cost. bgrun pays it *once* — its 225.9s is ~204s of job plus ~22s of agent work, with
`blocked_s` 0.0 because nothing waits synchronously. vanilla pays it repeatedly: 4 foreground runs
median, `blocked_s` 660.2, and the spread (283.8–732.4) is the session's own choice of how many times
to re-run the suite. This is the regime the async handoff is *for*, and it is the counterweight to
Cells 1/1b/3, where a 23–34s job made the wake's round trip the dominant cost.

Diagnosis is a tie — both arms reached `part-05.test.ts`, `cause_reached` 1, `diag_reach` 3/3 — and
that is the *best* version of the result: the same answer, at a quarter of the context, because
vanilla bought it by reading everything. Polls and wake claims are 0/0 in all three bgrun sessions,
which is the anti-poll fix holding under the cell where polling is most tempting.

## Variant — the same cell with the pointer (`--variant tracepreset`)

Condition: `<bench>/.pi/pi-bgrun.json` created with
`{ "digest": [ { "type": "test", "match": { "command": "*bun test*" }, "preset": "js-trace", "on": "failure" } ] }`.
This is the first cell in the battery with a digest configured at all, so it is the presets' and the
`on: "failure"` gate's first behavioural exercise. Artifacts:
[../long-buried-tracepreset/profile.csv](../long-buried-tracepreset/profile.csv).

| # | arm | wall_s | ctx_chars | calls | cause_file |
|---|---|---|---|---|---|
| bgrun-1..3 | bgrun | 233.1 [231.2–233.1] | **28,633** [21,867–31,481] | 5, 5, 6 | `part-05.test.ts` |
| vanilla-1..3 | vanilla | 974.3 [372.6–1188.5] | 99,546 [68,444–114,491] | 7, 7, 6 | `part-05.test.ts` |

**The pointer made the sessions work harder, and it named the wrong failure.** The digest block that
arrived in all three wakes:

```
digest (test): Failure: (pass) preset js-trace corpus (captured): bun test — stack above the `(fail)` summary (backward + earliest-of-run) [19.06ms]
```

A **passing** test's name. The preset's own label says it takes the "stack above the `(fail)`
summary", so it selected something it was not aiming at. The cause is self-reference: the suite under
test includes the preset's own corpus tests, which print captured failure text, so the log contains
failure-shaped strings from passing tests. The sessions did not trust it — calls rose from 3–4 to 5–6
(sequences like `bgrun bggrep bgtail bggrep bggrep`), context rose ~50%, and they still reached
`part-05.test.ts`. Correct outcome, higher price.

| | no pointer (baseline) | wrong pointer (variant) |
|---|---|---|
| calls | 3, 4, 4 | 5, 5, 6 |
| ctx_chars | 18,760 | 28,633 |
| wall_s | 225.9 | 233.1 |

**The design rule this buys: a pointer that can be wrong must be conservative — a wrong pointer costs
more than no pointer.** The digest fired ~20ms after the wake and its *scan* cost is nothing against
204s; the cost is that a session must verify a claim it cannot trust.

A caveat on attribution: the workload here is the extension's own suite, which is a pathological
digest input for this reason. That makes the *number* less general than the *rule*, and it means the
underlying preset defect (naming a passing test) needs fixing on its own merits, from this log —
which is kept at `<bench>/.pi-bgrun/jobs/bun-tests-1790622377-55299.log`.

Restore by **deleting** `.pi/pi-bgrun.json`; the battery's other cells all ran without one. The
pilot cell (in the product repo) remains the only cell that has ever run with a digest configured.
