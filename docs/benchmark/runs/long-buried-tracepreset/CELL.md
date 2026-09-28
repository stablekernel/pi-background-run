# Cell 4 variant — `long-buried` with the `tracepreset` pointer (2026-09-28)

**What ran.** The `long-buried` cell (Cell 4) re-run with a digest configured, so the
wake carried a pointer: `--variant tracepreset`, six sessions (3 bgrun / 3 vanilla),
same fixture, model and prompt as the baseline. Condition:
`<bench>/.pi/pi-bgrun.json` with `{ "digest": [ { "type": "test", "match": { "command":
"*bun test*" }, "preset": "js-trace", "on": "failure" } ] }` — the battery's first cell
with a digest at all, and the presets' and the `on: "failure"` gate's first behavioural
exercise. Workload: the same `bun test …` command as the baseline (570 tests, 1,281
lines, ~204s per run at the time of the run).

This is **not** a duplicate of the baseline `long-buried` cell: it is the same cell with
the pointer variant in play, and its numbers differ.

## What the profiles show

Medians `[min–max]`, from [profile.txt](profile.txt) / [profile.csv](profile.csv):

| arm | wall_s | blocked_s | ctx_chars | calls | locate | cause_file |
|---|---|---|---|---|---|---|
| bgrun (n=3) | 233.1 [231.2–233.1] | 0.0 | **28,633** [21,867–31,481] | 5, 5, 6 | pattern | `part-05.test.ts` |
| vanilla (n=3) | 974.3 [372.6–1188.5] | 935.5 | 99,546 [68,444–114,491] | 7, 7, 6 | full-read | `part-05.test.ts` |

`diag_reach` is 3/3 both arms; [wake-claims.csv](wake-claims.csv) shows 0 wake claims and
0 polls in every bgrun session. Against the no-pointer baseline (bgrun ctx 18,760, calls
3, 4, 4) the pointer made the bgrun arm work **harder**, not less.

## The finding it supports

The digest fired on the failing job but named a **passing** test —
`Failure: (pass) preset js-trace corpus (captured): …` — because the suite under test
contains the preset's own corpus tests, which print failure-shaped text. Sessions did not
trust it (sequences like `bgrun bggrep bgtail bggrep bggrep`), so calls rose from 3–4 to
5–6 and context rose ~50%, still reaching `part-05.test.ts`. A wrong pointer costs more
than no pointer.

Full write-up: [../long-buried/CELL.md](../long-buried/CELL.md) ("Variant") and
`results.md` Cell 4. This run is the wrong-pointer leg of the pointer question tracked as
product issue #33, and the preset defect it exposed (naming a passing test) is the
evidence-rule work tracked as product issue #34.
