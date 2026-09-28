# Cell 3a — `trace-root` with the framing fix only (`--variant framewake`)

The same cell, fixture (`605aba38baf5c6ad`), model, prompt and interleaving as [Cell 3](CELL.md),
run after the wake's closing line changed from "the exit code, stats and last output above **are the
result**" to "a summary, not the diagnosis — the log holds the detail, including the context around
any failure. For a failing job, read a window around the failure before concluding a cause."

**Nothing else changed.** The project's digest was left as it was — a hand-rolled pass/fail count —
so no preset, no pointer, and no ecosystem-specific code was in play. Extension: bench `7949ea0`
(trace presets and the failure gate present but *unused* here).

| field | value |
|---|---|
| profile | [profile.txt](profile.txt), [profile.csv](profile.csv), [wake-claims.csv](wake-claims.csv) |
| before | [wake-claims-before.csv](wake-claims-before.csv) — the same instrument over Cell 3 |

## Result

| # | arm | wall_s | blocked_s | ctx_chars | calls | locate | cause_file |
|---|---|---|---|---|---|---|---|
| bgrun-1 | bgrun | 39.2 | 0.0 | 13,559 | 3 | pattern | `harness.ts` |
| bgrun-2 | bgrun | 43.9 | 0.0 | 16,243 | 3 | pattern | `harness.ts` |
| bgrun-3 | bgrun | 40.7 | 0.0 | 14,009 | 3 | pattern | `harness.ts` |
| vanilla-1..3 | vanilla | 34.5 [33.2–34.6] | 22.8 | 29,721 | 1 | full-read | `harness.ts` |

## The finding

| metric | Cell 3 | Cell 3a |
|---|---|---|
| `harness.ts` in the bgrun arm's context | **0, 0, 0** | **3, 3, 5** |
| `cause_file` (deepest frame seen) | `part-02.test.ts` | **`harness.ts`** |
| tool calls | 2 | 3 |
| ctx_chars (median) | 9,758 | 14,009 |
| polls before the wake / wake claims | 0 / 0 | 0 / 0 |

**Two sentences of language-neutral framing fixed the cell.** No preset, no digest change, no
ecosystem vocabulary — the instruction "read a window around the failure" carries no knowledge of how
any runner spells a stack frame.

The mechanism is visible in the call sequences. Cell 3's sessions ran `bgrun` → `bggrep` and stopped.
Cell 3a's run `bgrun` → `bggrep` → **`bgtail`**: they searched for the symptom, then read the window
around the failure, which is where the frames are. The extra call costs ~4k characters and buys the
cause — and the arm still lands at half vanilla's context (14,009 against 29,721).

## What this settles, and what it does not

- **The general fix is instruction, not parsing.** The presets and the `on: "failure"` gate are
  *precision* layers — they name a failure and its frame in the wake — not the thing that made the
  session reach the cause. That also retroactively justifies deleting the built-in locator: the
  JS-tuned regex was never the fix, and a neutral instruction did better.
- **The wall floor stands.** bgrun is 40.7s against vanilla's 34.5s: the job plus the wake's arrival
  is structural, as it was in Cells 1b and 3.
- **Not tested here:** whether the pointer *adds* anything on top of this. That is variant B
  (`--variant tracepreset`, with `{ "type": "test", "preset": "js-trace", "on": "failure" }` in the
  project config), and it now measures an increment rather than a fix — the primary outcome is
  already achieved. `frames_opened` stayed 0 in both arms, since neither addressed the cause file
  *directly*; both found it inside a window.
- **n=3, one model, one fixture.** The effect is uniform across all three sessions and in the
  predicted direction, but three sessions demonstrate; they do not generalise.
