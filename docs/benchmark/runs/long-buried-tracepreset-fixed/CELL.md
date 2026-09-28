# Cell 4 variant — `long-buried` with the fixed `tracepreset` pointer (2026-09-28)

**What ran.** The `long-buried` pointer variant re-run after `75a2c1f` anchored the
preset on real evidence: `--variant tracepreset-fixed --arms bgrun`, **three bgrun
sessions only** — vanilla was omitted by design (see
[../long-buried/RUNSHEET.md](../long-buried/RUNSHEET.md)), because the fixed pointer can
only move the bgrun arm. Same fixture, model and prompt as the baseline; the
`.pi/pi-bgrun.json` digest matched the wrong-pointer variant but with the fixed preset.

This is **not** a duplicate of the baseline or the wrong-pointer cell: it is the same
cell with the corrected pointer, and its numbers differ again. Vanilla has no sessions
here, so no arm comparison is made from this directory.

## What the profiles show

Medians `[min–max]`, from [profile.txt](profile.txt) / [profile.csv](profile.csv):

| arm | wall_s | blocked_s | ctx_chars | calls | locate | cause_file |
|---|---|---|---|---|---|---|
| bgrun (n=3) | 234.0 [232.8–256.3] | 0.0 | **33,799** [29,180–36,355] | 5, 5, 8 | pattern | `part-05.test.ts` |

`diag_reach` is 3/3; [wake-claims.csv](wake-claims.csv) shows 0 wake claims and 0 polls.
All three wakes named the **true** failure this time —
`AssertionError … at TestContext.<anonymous> (/private/tmp/long-buried-fixture/part-05.test.ts:59:9)`.

## The finding it supports

The cost went **up**, not down. Against the baseline (no pointer: ctx 18,760, calls 3, 4,
4) and the wrong pointer (28,633; 5, 5, 6), the correct pointer is the most expensive:
**33,799, 5, 5, 8**, non-overlapping with the baseline on both calls and context. The
sequences say why — `bgrun bggrep bggrep bgtail bggrep`: every session *verified* the
pointer and then searched anyway. The rule: **a pointer is a hypothesis the session must
still verify, and where the session can search cheaply that costs more than it saves.**

Full write-up: [../long-buried/CELL.md](../long-buried/CELL.md) ("Variant 2") and
`results.md` Cell 4. This run completes the pointer question tracked as product issue
#33; the preset evidence fix it validates is product issue #34.
