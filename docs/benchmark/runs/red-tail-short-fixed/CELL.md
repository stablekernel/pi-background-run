# Cell 1b — `red-tail-short`, re-run after the no-poll change (2026-09-28)

The same cell as [Cell 1](../red-tail-short/CELL.md), run again after changing the extension, to
test the mechanism Cell 1 exposed. Everything else is held fixed: the same fixture (sha
`0bfe00ed1d9866b9`), model, neutral prompt, command and interleaving — the only difference is the
tool code.

| field | value |
|---|---|
| extension | bench commit `8750f0e`; sha `18f022248c9f4552` — product branch `fix/no-poll-before-wake`, commit `5e43fba` |
| Cell 1's extension | sha `b6539e3fab30bb99` |
| what changed | `bgrun`'s result states the task is done at handoff; `bgtail`/`bggrep` answer a still-running job with its state (elapsed, no exit code) instead of its log; `peek: true` is the live-read opt-in |
| profile | [profile.txt](profile.txt), [profile.csv](profile.csv), [wake-claims.csv](wake-claims.csv) |
| before | [wake-claims-before.csv](wake-claims-before.csv) — the same instrument over Cell 1's transcripts |

## Result

| # | arm | execs | wall_s | blocked_s | ctx_chars | diag | locate | cause | calls |
|---|---|---|---|---|---|---|---|---|---|
| bgrun-1 | bgrun | 1 | 42.7 | 0.0 | 9,892 | up+down | pattern | reached | 2 |
| bgrun-2 | bgrun | 1 | 38.1 | 0.0 | 9,841 | up+down | pattern | reached | 2 |
| bgrun-3 | bgrun | 1 | 40.9 | 0.0 | 10,031 | up+down | pattern | reached | 2 |
| vanilla-1 | vanilla | 1 | 33.5 | 22.4 | 28,000 | up+down | position | reached | 1 |
| vanilla-2 | vanilla | 1 | 33.9 | 22.4 | 28,236 | up+down | position | reached | 1 |
| vanilla-3 | vanilla | 1 | 32.3 | 22.4 | 28,021 | up+down | position | reached | 1 |

## Before and after

| metric | Cell 1 | Cell 1b | vanilla |
|---|---|---|---|
| wake claims before exit | 1, 2, 1 | **0, 0, 0** | — |
| calls before exit | 11, 10, 6 | **1, 1, 1** | 1, 1, 1 |
| polls before exit | 10, 9, 5 | **0, 0, 0** | — |
| tool calls per session | 12, 11, 9 | **2, 2, 2** | 1 |
| ctx_chars (median) | 31,170 | **9,892** | 27,817 → 28,021 |
| wall_s (median [min–max]) | 45.4 [42.9–51.1] | 40.9 [38.1–42.7] | 33.0 → 33.5 |
| blocked_s | 0.0 | 0.0 | 22.5 → 22.4 |
| diag_reach | 3/3 | 3/3 | 3/3 |

`calls_before_exit` includes the call that *starts* the job, which is by definition made while the
job is about to run. The poll count is that number minus the handoff: Cell 1 made 10, 9 and 5
polls; Cell 1b made none.

## Mechanism, from bgrun-1's transcript

The whole interaction is `bgrun` → yield → wake → one search → answer:

```
14:47:50  bgrun → "✅ Your part is done — end your turn now. Nothing to wait for…"
14:47:52  TEXT: "Launched — I'll report the failure details when the run completes."
14:48:13  the wake arrives (the job exited at 14:48:11, exit 1)
14:48:16  THINK: "Let me check the failures by searching for failure patterns in the log."
          → bggrep, 23 matches
14:48:25  final answer naming part-02.test.ts, line 58
```

No session claimed a wake, none read the log before the wake, and there was nothing to gain from
one: a reader call before the wake now answers "still running — Ns elapsed, no exit code yet" and
nothing else. All three sessions did the same thing, to the same numbers.

**`locate` flipped from `position` to `pattern`**, and that is why the context column inverted:
given the wake and no accumulated log, the session searched the log instead of reading it, so it
never loaded the ~26.6k characters Cell 1's sessions loaded in pieces. bgrun now costs *less*
context than vanilla — 9,892 against 28,021 — instead of 12% more.

## Verdict

- **`H12 <fabricated-wake>`: supported and fixed.** The claim did not recur (0 of 3, from 3 of 3)
  and the polls it licensed went to zero. The change addresses the three gaps Cell 1 identified:
  the clock (elapsed, no exit code), the payoff (content gated), and the missing action ("end your
  turn").
- **The cell stays negative on wall time**, exactly as the floor argument predicted before this
  run: the job is 23.2s and the wake lands ~7s after it exits, so bgrun's best case is vanilla's
  22.4s of blocking less the turn it saves — 40.9s against 33.5s here. The fix removed the
  self-inflicted cost, not the structural one.
- **No regressions:** blocked 0.0, `diag_reach` 3/3, `cause_reached` 3/3, `execs` 1 in every
  session.
- **The control held:** vanilla is unmoved from Cell 1 (33.5 vs 33.0 wall, 28,021 vs 27,817
  context, 1 call), so the bgrun change is what moved.
- **n=3, one model, one fixture.** The spread is tight and the effect is uniform, but three
  sessions demonstrate rather than generalise. `trace-root` tests the other prediction, and
  `long-buried` is the cell where a job is long enough for mid-run waiting to be a real strategy
  rather than a formality — which is also the cell where the gate's cost is highest.

## Instrument note

The cell's command emits two pre-existing noise sources, identical for both arms and unrelated to
the change: a `NotImplementedError` from running `node:test` files together under Bun (`test()`
inside `test()`, bun#5090), and occasionally a 4s wake-timeout flake in the extension's own
bgtail-cap test under the combined load. The extension's suite in isolation is 231 pass / 0 fail,
twice.
