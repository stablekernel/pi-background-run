# Predictions, written before the runs

Every cell in the battery has a prediction here, recorded **before** it is run, with
the mechanism that should produce it and the result that would falsify it. All of it
is prediction: no number below comes from a measurement, and nothing here may be
edited after a run — a changed prediction is added as a dated amendment, so the record
shows what was believed when.

Two rules give this its only value:

1. **Every cell is reported**, including the ones that make the tool look bad.
2. **A falsified prediction stays in the document**, marked falsified, with what it
   means. The interesting result is the one that contradicts us.

Hypotheses are named, not numbered, so a *cell* and a *claim* never get confused for
one another. `H7 <capability>` is the load-bearing one and by far the most likely to
hurt.

## Mechanism hypotheses

> Earlier drafts of this register labelled cells `R1`–`R5`, `P1`–`P2`, `C1`–`C4` and
> `D1`. Those labels belonged to the withdrawn measurements. The capability axis
> replaced `D1`, which was never a cell. Mapping: `green-short`←R1,
> `red-tail-short`←R2, `long-buried`←R3, `fast-verbose`←R4, `fail-fast`←R5,
> `pty-fixture`←P1, `pty-agent`←P2, `overlap-task`←C1, `parallel-jobs`←C2,
> `resume-midrun`←C3, `peek-midrun`←C4.

| hypothesis | claim | falsified by | confidence |
|---|---|---|---|
| `H1 <pty-shape>` — **FALSIFIED** | the claim was: bun's reporter emits a per-test line when stdout is a terminal and omits it for a pipe. **The real variable is the environment, not the terminal.** With `AGENT`/`CLAUDECODE` set — the environment every pi session actually runs in — bun suppresses per-test lines in *both* shapes, and pipe and pty output are byte-identical. Outside that environment, with a colour-capable `TERM`, per-test lines appear in *both* shapes and differ only in format (`✓ name` on a pty, `(pass) name [dur]` on a pipe), so neither shape is ever larger | — (falsified before any battery run, by `scripts/pty-shape.ts`, then re-run in both environments to confirm; see [results.md](./results.md)) | was high |
| `H2 <shape-drives-reading>` — **VOID** | was: an agent's window choice follows the output *shape*, not only its size. In an agent environment there is no shape difference to follow, so the hypothesis cannot be tested as stated and `pty-agent` is dropped | n/a — void by `H1`'s falsification, not by measurement | was medium |
| `H3 <variance-not-median>` | bgrun's advantage is variance reduction, not median cost: vanilla's best run beats every bgrun run | bgrun's median beats vanilla's median on any cell | medium |
| `H4 <negative-cells>` | on `fail-fast` and `red-tail-short` bgrun buys nothing | bgrun wins either cell | medium-high |
| `H5 <mechanism-stable>` | mechanism columns are stable across runs; agent columns are not | the reverse pattern appears | high |
| `H6 <unattended>` | a bgrun cell can be run unattended if pi is held open interactively in a pty, with the wake landing in the live session | the wake never arrives, or arrives as a fetched tool result, or the session dies before the job ends | medium |
| `H7 <capability>` | **the load-bearing one**: capable agents *grep for the failure* (`grep -i fail`, `sed -n '/FAIL/,+40p'`) rather than guessing positional windows — so bgrun's central claim shrinks to the cases where no pattern finds it | agents guess positional windows more often than they grep, as measured by the `locating` column | unknown — this is the hypothesis most likely to hurt, and the reason `long-buried` is in the battery |
| `H8 <ladder-gradient>` | the locating-strategy mix is a **function of capability**: weak rungs guess positions, strong rungs grep, so bgrun's advantage shrinks as capability rises | the mix is flat across rungs — in which case locating strategy is a property of the *prompt*, not the agent, and capability is the wrong axis | low-medium |
| `H9 <digest-starves>` | a session that trusts the wake and does not open the log stops at the digest. The digest is **counts only** (`299 pass`, `1 fail`) and never names the failing test, so such a session cannot reach even the *symptom*. The tool's guidance says to read the log when the wake is not enough; this asks whether sessions do | sessions reach the failing test without opening the log and without being told to, or they open it unprompted in nearly every run | high on mechanism — **half of it measured already**, see [results.md](./results.md) — and unknown on behaviour |
| `H10 <condenser-eats-traces>` — **FALSIFIED (narrow form live)** | the claim was: `bgtail`'s condenser (repeats collapsed, long lines capped) mutilates a stack trace — merging or dropping the frame that matters — so the bgrun arm's own reader is a footgun on exactly the cells where *following* the evidence, not finding it, is the cost. **Measured**: a condensed read of a real failure block preserved the assertion text, all 9 frames, both fixture locations and the markers, nothing merged or dropped. It stays live only in the narrow form the check could not exercise — a trace with *repeated identical frames*, which the collapse rule would merge | — (falsified as stated, before any battery run, by a job plus `bgtail` on its log; see [results.md](./results.md)) | was medium |
| `H11 <trace-depth>` | reaching a root cause is a **capability boundary, not a reading-strategy one**: capable rungs open the frame the trace names, weak rungs report the assertion text and stop. Unlike `H8 <ladder-gradient>` this predicts a difference in what the agent *does with what it found*, not in how it looked | `cause_reached` is flat across rungs | medium |
| `H12 <fabricated-wake>` | polling in a bgrun session is evidence of a **licence invented on the spot, not impatience or confusion**: every session intends to wait ("I'll wait for the job to finish") and none can — an agentic loop has no idle primitive, only checks — so each asserts the completion wake in the same breath as the check that contradicts it. bgrun-2 states both at once: *"Still running — I'll wait for the wake. --- **Wake received.** Let me read the tail"*. Nothing in `bgtail`/`bggrep` contradicts the claim, because a delta read of a running job looks like a perfectly good result, and no tool result carries a clock, so the claim is unfalsifiable from inside the loop. Measured in Cell 1: **3/3** bgrun sessions polled 9–12 times, all three with the wake claim in writing | the claim does not recur once `bgtail`/`bggrep` return state only while running (elapsed + no exit code, content gated behind `peek: true`) — or if it is absent from the other two cells' bgrun arms | medium-high on the licence reading (3/3 sessions; bgrun-2 asserts both states in one message, which a factual belief cannot do); low on generality beyond this model and fixture |

## Cell register

Prediction format: what happens, to which metric, and roughly how much. "Winner" means
cheaper for the same information, not merely different.

| cell | prediction | mechanism | falsifier | conf. |
|---|---|---|---|---|
| **`green-short`** repo suite, green | vanilla cheaper by median; **bimodal** — it either tails the output or floods context with all of it. bgrun's spread is small. Blocked: the suite's runtime vs **0.0s** | no waiting exists; the only variable is how the agent reads | vanilla's spread is as tight as bgrun's, or bgrun exceeds vanilla's *worst* case | high on mechanism, medium on context |
| **`red-tail-short`** red, failure near the end | vanilla wins the median (one window reaches it, one call); its range is one to several executions. bgrun: one execution, 0.0s blocked. **Also a ladder cell** | the diagnostic is reachable positionally, so nothing forces a re-run | vanilla never re-runs, or bgrun's context falls below vanilla's best | medium-high |
| **`long-buried`** generated, failure buried mid-run | bgrun wins executions (1 vs ≥2) and blocked time (0.0s vs the runtime, once or twice). **Context may go either way.** **Also a ladder cell** | no positional window reaches a failure buried in the middle, so vanilla pays a second full run | **the agent greps by pattern instead of windowing**, pinning the failure in one cheap call — see `H7 <capability>` | medium |
| **`trace-root`** generated, symptom near the end, cause three frames down | **expected struggle for bgrun**, and it leans vanilla: the symptom is one grep away, so locating is cheap, while the *cause* is a frame the session has to open and read. Every layer that summarises between the session and the log is a way to lose that frame — and the wake digest is one (`H9`), as is `bgtail`'s condenser (`H10`). **Also a ladder cell**, and the one where a rung difference shows up in what the agent does with the trace rather than in how it searched (`H11`) | locating cost is low and following cost is high; the failure's *reason* is not in the failure's text | bgrun reaches `cause_reached` at least as often and no more expensively than vanilla, **or** the condenser proves to preserve traces intact | medium — direction honestly unknown |
| **`fast-verbose`** volume without duration | **expected struggle**: near-tie on time; vanilla cheaper if it windows, worse if it floods. bgrun's gain is a greppable, delta-readable log | volume without duration creates no blocking cost | bgrun wins on context at equal information | low-medium |
| **`fail-fast`** failure ends the run early | **expected struggle**: vanilla wins wall and context; the wake is overhead | the run ends at the failure, so the property bgrun exploits is gone | bgrun wins | high on direction, unknown on size |
| **`pty-fixture`** runner output, pty vs pipe | was: pty = pipe + a per-test line | — | **falsified by `H1`**: identical in an agent environment, format-only difference outside it. Kept as a standing instrument check, because it pins the output shape every other cell's numbers depend on | done, falsified |
| ~~**`pty-agent`**~~ **dropped** | was: the agent keeps its window *size* habit, but a pty shape pushes the failure further from the end, so the window misses more often and any pipe-mode figure understates vanilla's bad case | — | **void**: in an agent environment the two shapes are byte-identical, so the cell cannot measure anything | — |
| **`overlap-task`** long job + unrelated task | bgrun wins wall-clock by roughly the overlap, and blocked 0.0s against the job's runtime | the wake frees the session to work elsewhere | **the agent waits or polls anyway** — plausible, and the point of the cell | medium-high on capability, medium on behaviour |
| **`parallel-jobs`** three long jobs at once | bgrun wins *session availability*; **wall may tie** | a capable vanilla agent can background all three in one call (`&`, `wait`), but the session is still hostage to it | vanilla's `&`+`wait` matches bgrun on wall *and* session freedom | medium |
| **`resume-midrun`** session ends mid-run | bgrun wins categorically: the log and `bgstatus` outlive the session; the foreground result died with it | the log is on disk | vanilla simply re-runs and the gap is small — direction holds, magnitude shrinks | high on direction, medium on size |
| **`peek-midrun`** ask where a run is | bgrun wins the cell; **low real-world frequency** | only a detached job can be asked mid-flight | a vanilla agent self-redirects and backgrounds, and answers the same way | high on direction, low on value |

## Amendments

Dated notes for measurements that land *before* a battery run, so the register shows the
prediction as it was written next to the evidence that arrived later.

- **2026-09-26.** The `trace-root` row predicted two mechanisms that could lose the frame
  on the bgrun side: the wake digest (`H9 <digest-starves>`) and `bgtail`'s condenser
  (`H10 <condenser-eats-traces>`). Both have now been measured as instrument checks. The
  digest is **counts only** and never names the failing test, so on this cell the bgrun
  arm's wake is strictly poorer than a terminal's, and the question becomes whether the
  session opens the log at all. The condenser **kept every frame** of a real trace,
  falsifying `H10` as stated. The row's prediction — that `trace-root` leans vanilla — is
  **unchanged and still untested**: the mechanism is now known, the behaviour is not.

## The capability ladder

Applied to `red-tail-short`, `long-buried` and `trace-root`, crossed with three rungs.
The first two ask how the agent *looked*; `trace-root` asks what it did with what it
found. Predicted per-rung behaviour, and the reason the ladder exists at all:

| rung | predicted `locating` mix | predicted effect on bgrun's edge |
|---|---|---|
| weak | mostly `position`, some `full-read`; more re-runs and more context | edge at its largest |
| mid | mixed: `pattern` on failures that name themselves, `position` otherwise | edge moderate |
| strong | `pattern` first, one call, small context | edge at its smallest — possibly gone |

On `trace-root` the same rungs are read through `cause_reached` rather than `locating`:
weak stops at the symptom text, mid opens the frame the trace names, strong opens it and
names the reason. That is `H11 <trace-depth>`, and it can fail in the same flat way.

Falsified by a flat mix across rungs, which would mean the locating strategy is driven
by the prompt or the failure's shape rather than by the agent's capability, and that
the capability axis is measuring nothing.

## Where bgrun should shine, and where it should struggle

From the mechanism, before any measurement:

**Should shine** — long runs; a failure buried in bulk; more than one thing to do at
once; a session that may end before the job does; a question about a run in progress;
and when nobody wants to read the log at all (the digest carries the answer).

**Should struggle** — short runs; failures a window reaches; **failures a pattern
finds**; fail-fast; a fast-but-noisy command; and the audience that already has a
terminal: `&`, `tmux`, a split pane; and **failures whose cause is a frame away**
(`trace-root`), where the diagnostic is cheap to find and expensive to follow, and every
summarising layer between the session and the log is a place the frame can be lost. In
CI, none of it applies.

**What falsification would mean.** If `H7 <capability>` holds — if capable agents grep
for the failure rather than guess at windows — then bgrun's positional advantage is
mostly a story about weak agents, and the honest claim becomes narrower: non-blocking,
an untruncated log, and durability across sessions, with the context argument conceded
against a competent agent. That outcome is worth publishing, which is why the cell
that could produce it is in the battery.

## Reporting

Each cell's outcome is recorded in [results.md](./results.md) as **confirmed**,
**falsified**, or **inconclusive** (with why), against the prediction above. A
falsified cell keeps its row and gains a note; a prediction is never edited to match a
result.
