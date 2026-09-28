# Predictions, written before the runs

Every cell had a prediction recorded **before** it ran, with the mechanism that should
produce it and the result that would falsify it. Nothing here is edited after a run — a
changed prediction is added as a dated amendment — so a **falsified** or **void** entry
stays, marked, with what it means; that is the document's only value. Hypotheses are
named (`H1`–`H12`), never numbered against cells, so a *cell* and a *claim* are not
confused. [results.md](./results.md) records each cell's outcome against them —
**confirmed**, **falsified**, or **inconclusive** — and the procedure that produces
those rows is in [method.md](./method.md).

## Tested — outcome per hypothesis

| hypothesis | outcome |
|---|---|
| `H1 <pty-shape>` — **FALSIFIED** | the claim was: bun's reporter emits a per-test line when stdout is a terminal and omits it for a pipe. **The real variable is the environment, not the terminal.** With `AGENT`/`CLAUDECODE` set — the environment every pi session actually runs in — bun suppresses per-test lines in *both* shapes, and pipe and pty output are byte-identical. Outside that environment, with a colour-capable `TERM`, per-test lines appear in *both* shapes and differ only in format (`✓ name` on a pty, `(pass) name [dur]` on a pipe), so neither shape is ever larger. Falsified before any battery run by `scripts/pty-shape.ts`, then re-run in both environments to confirm. |
| `H2 <shape-drives-reading>` — **VOID** | was: an agent's window choice follows the output *shape*, not only its size. In an agent environment there is no shape difference to follow, so the hypothesis cannot be tested as stated and `pty-agent` is dropped. Void by `H1`'s falsification, not by measurement. |
| `H3 <variance-not-median>` | bgrun's advantage is variance reduction, not median cost: vanilla's best run beats every bgrun run. **Addressed, not settled**: every cell reports n≥3 with median *and* range per arm — the only form this claim can be read in — and the falsifier (bgrun's median beats vanilla's median on any cell) has not been read off it. |
| `H5 <mechanism-stable>` | mechanism columns are stable across runs; agent columns are not. **Holding**: across the recorded cells the mechanism columns (`execs`, `fg`, `handoff`, `blocked_s`) stay fixed while the agent columns (`ctx_chars`, `wall_s`, `calls`, `locating`) move — the split the method rests on. Falsified by the reverse pattern appearing. |
| `H6 <unattended>` — **NEGATIVE** | a bgrun cell can be run unattended if pi is held open interactively in a pty, with the wake landing in the live session. **It cannot be held open that way**: with stdin `/dev/null` the session exits before its own job finishes; without a pty it quits when its turn ends; holding the input open on a FIFO hangs instead. Cells a human drives are therefore measured from a run-sheet — a *method* difference, because it bounds what may be claimed for them. The attended loop itself was verified separately (pilot, 2/2). |
| `H9 <digest-starves>` | a session that trusts the wake and does not open the log stops at the digest. The digest is **counts only** (`299 pass`, `1 fail`) and never names the failing test, so such a session cannot reach even the *symptom*. **Narrow form measured (Cell 3, `trace-root`)**: the digest is counts-only, so it cannot point at the frame, and the session's follow-up search found the symptom file but never the cause file — `harness.ts` appeared in **0 of 3** bgrun sessions against **3 of 3** vanilla. The full claim — a session that trusts the digest and does not open the log at all — remains untested: every bgrun session did open it. |
| `H10 <condenser-eats-traces>` — **FALSIFIED (narrow form live)** | the claim was: `bgtail`'s condenser (repeats collapsed, long lines capped) mutilates a stack trace — merging or dropping the frame that matters — so the bgrun arm's own reader is a footgun on exactly the cells where *following* the evidence, not finding it, is the cost. **Measured**: a condensed read of a real failure block preserved the assertion text, all 9 frames, both fixture locations and the markers, nothing merged or dropped. It stays live only in the narrow form the check could not exercise — a trace with *repeated identical frames*, which the collapse rule would merge. Falsified before any battery run. |
| `H12 <fabricated-wake>` — **SUPPORTED AND FIXED (verified)** | polling in a bgrun session is evidence of a **licence invented on the spot, not impatience or confusion**: every session intends to wait ("I'll wait for the job to finish") and none can — an agentic loop has no idle primitive, only checks — so each asserts the completion wake in the same breath as the check that contradicts it. bgrun-2 states both at once: *"Still running — I'll wait for the wake. --- **Wake received.** Let me read the tail"*. **Measured in Cell 1: 3/3 sessions, 27 of 30 calls made while the job ran, first claim 3–4s into a ~23s job. After the fix (Cell 1b, same cell and fixture): 0 of 3 sessions, 0 polls, 2 calls each** — `bgrun` → yield → wake → one `bggrep` → answer. High on mechanism and on the fix within this model and fixture (3/3 → 0/3); unknown on generality. |

## Untested — no evidence yet

These registrations have no runs behind them, and **no claim in this work rests on
them**: `H4`'s `fail-fast` half, `H7`, `H8`, and `H11`. `H7`, `H8` and `H11` all need
the **capability ladder**, which has never run; `H4`'s unrun half needs the `fail-fast`
cell.

- `H4 <negative-cells>` — **half-tested**. `red-tail-short` ran (Cell 1) and **supported** it: the diagnostic was one window away, so bgrun bought nothing. The **unrun half** is `fail-fast`, where the run ends at the failure and the wake is pure overhead.
- `H7 <capability>` — **the load-bearing one.** Capable agents *grep for the failure* (`grep -i fail`, `sed -n '/FAIL/,+40p'`) rather than guessing positional windows, so bgrun's central claim shrinks to the cases where no pattern finds it. Falsified if agents guess positional windows more often than they grep, as the `locating` column would show. If it holds, the honest claim narrows to non-blocking, an untruncated log, and durability across sessions, with the context argument conceded against a competent agent.
- `H8 <ladder-gradient>` — the locating-strategy mix is a **function of capability**: weak rungs guess positions, strong rungs grep, so bgrun's advantage shrinks as capability rises. Falsified by a flat mix across rungs, which would make locating a property of the *prompt*, not the agent, and capability the wrong axis.
- `H11 <trace-depth>` — reaching a root cause is a **capability boundary, not a reading-strategy one**: capable rungs open the frame the trace names, weak rungs report the assertion text and stop. **Read `cause_reached` with `cause_file`**: it is session-relative — the deepest frame *that session saw* — so on a fixture whose cause is a separate file it reads 1 for a session that never saw the cause (Cell 3: both arms 1, while the cause file appeared **0/3** bgrun against **3/3** vanilla). Falsified by `cause_file` flat across rungs.

The per-rung predicted tables that used to sit here are gone with the ladder that never
ran; the tested register above is the whole of what has been decided, and whatever does
run later is read off it there.
