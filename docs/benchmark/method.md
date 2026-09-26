# Benchmarking bgrun against foreground `bash`

How the claims about bgrun's effect on a session are produced, and what they are
allowed to mean. Predictions live in [predictions.md](./predictions.md), results in
[results.md](./results.md) — kept apart so a prediction cannot be quietly rewritten
after the fact.

## Why this exists

An earlier round of measurements was abandoned. Not because the tool changed, but
because the *measuring* was unsound, in five specific ways:

1. Cells ran while the repository, the fixture and the measurement tool were being
   edited on the same machine.
2. The invocation context was never recorded, and it matters: bun's reporter behaves
   differently when its stdout is a terminal than when it is a pipe, so "the same
   suite" can have two different output shapes depending on how it was run.
3. Sessions were mixed across contexts — some live, some one-shot — without that
   being visible in the numbers.
4. A worktree was removed underneath a running job.
5. The write-up's numbers could not be traced to a transcript, so nothing could be
   re-checked.

The controls below exist to make each of those impossible, or at least visible.

## Controls

| control | the failure it prevents |
|---|---|
| **Freeze the tree.** No commits, no branch operations, no `install`, no test runs by anyone else while a battery is running. | measurements taken against code that moved underneath them |
| **Serialize.** One cell at a time, in one battery job. Nothing else heavy on the machine. | contention inflating every timing column |
| **Record the machine.** Note load and any concurrent work in the run manifest. | a slow run explained away later as noise |
| **Declare the environment, not just the terminal.** Every session records `AGENT`, `CLAUDECODE`, `CI`, `NO_COLOR`, `TERM`, and whether commands ran on a pty or through a pipe. | comparing two different *output shapes* as if they were one — which is precisely what happened here: the shapes turn out to differ by environment, not by terminal |
| **Pin the fixture.** Hash the generated fixture's files; record the hash per cell. | silently measuring a different fixture than the one described |
| **Manifest per session.** One file beside each transcript recording every parameter below. | unstated method differences between cells |
| **Generate the tables.** The profiler emits the rows; nobody retypes a number into prose. | transcription drift and untraceable figures |
| **No edits during a battery.** Not even documentation. | a battery contaminated by its own author |

## Cells

A cell is a **fixture × arm × context**, at one model. Compare only within a cell, and
only between runs that share a manifest.

**Arms**

| arm | what it is |
|---|---|
| `vanilla` | `pi` with the provider extension, no bgrun |
| `bgrun` | the same, plus this repo's extension |
| `vanilla-hinted` | `vanilla`, but the prompt suggests redirecting the run to a file and grepping it — the technique bgrun implements, hand-rolled by the agent. The strongest baseline in the set |

**Contexts**

| context | meaning |
|---|---|
| `one-shot` | `pi -p …`: one turn, then the process exits. Usable for vanilla cells; **useless for bgrun cells**, because the wake is delivered to a live session and a one-shot session is gone before the job ends |
| `live` | an interactive session that stays open. Required for every bgrun cell |
| `pty` / `pipe` | how the *commands inside* the session see their stdout. Recorded, never assumed |

**Fixtures** (all from `scripts/make-dummy-suite.ts`; knobs documented in its header)

| id | recipe | the axis it isolates |
|---|---|---|
| `green-short` | the repo's own suite | the everyday case: no waiting, modest output |
| `red-tail-short` | the repo's suite plus a fixture that fails near the end of the output | failure position, short run |
| `long-buried` | generated, default knobs | duration and volume together |
| `fast-verbose` | generated with `DUMMY_SLEEP_MS=20`, `DUMMY_LINES_PER_TEST=8` | volume without duration |
| `fail-fast` | generated with `DUMMY_FAIL_FAST=1` | a failure that ends the work early |
| `trace-root` | generated; the failing test raises the error from a helper frame, so the trace names a location that is not the assertion site | **diagnosis depth**: the symptom is cheap to find and the cause is a frame away (`H11 <trace-depth>`). The generator's current trace already names a second location in the same file, so the cell is affordable as it stands; a dedicated helper *file* is a small addition that would sharpen it |

**Dialogues** — `overlap-task` (start a long job, then do an unrelated task),
`parallel-jobs` (several long jobs at once), `resume-midrun` (the session ends and
resumes mid-run), `peek-midrun` (ask where a run is, mid-run). No generated fixture
can express these: what is under test is what the session does *while* a job runs, and
what survives afterwards.

**Shape probe** — `pty-fixture`: the runner's output under a pty versus a pipe, no
agent involved. It is an *instrument check*, run before a battery to pin the output
shape every other cell depends on, and its first run falsified the reason it was built
(`H1 <pty-shape>`). `pty-agent` is dropped (`H2`).

Two more standing instrument checks joined it in Phase 1. The **environment
comparison** runs the same fixture in an agent and a non-agent environment — the check
which established that the *environment* is the variable, and whose first run was
invalid because `bgrun` does not inherit `AGENT`/`CLAUDECODE`, so both halves were the
same environment. That is why its header prints the environment and why no shape may be
quoted without one. The **trace path** check asks what the wake digest and `bgtail`
actually show of a failing test's stack trace, since a batched job's evidence reaches a
session through those two doors and through nothing else.

### The capability axis

`H7 <capability>` asks whether agents *grep for a failure* or *guess a positional
window* — which decides the whole story, because bgrun's central claim is that it
removes the guess. That is a claim about the agent, so a single model cannot test it.

- **Crossed with**: `red-tail-short` and `long-buried` only — the two cells where the
  locating strategy decides the outcome. Every other cell runs at one model, to keep
  the battery affordable.
- **Rungs**: `anthropic/claude-haiku-4-5` → `anthropic/claude-sonnet-4-6` →
  `anthropic/claude-opus-5`. Each was probed for availability before anything depended
  on it, and they were chosen as a **same-family** ladder so that a difference in
  locating strategy is attributable to capability rather than to one lab's tool-calling
  format, prompt handling or tokenizer. Note the floor: this gateway serves no genuinely
  small model (its entire `bedrock/*` wire is unserved, and its smallest open model is a
  120B MoE), so the low end of the ladder is bounded by availability rather than by
  design — see the limits below, and `gpt-oss-120b` is worth a floor *probe* to document
  where agentic behaviour actually breaks rather than as a rung.
- **Rule**: **never compare wall-clock across rungs.** Per-call latency differs by
  model, so cross-model wall comparisons are meaningless. Compare each rung's own
  vanilla-versus-bgrun *delta*, and its locating-strategy mix.

## The fixture, and why it is shaped that way

The generated suite (`bun run bench:make-suite`, `scripts/make-dummy-suite.ts`) is
generated rather than committed because `bun test` discovers `*.test.ts` anywhere in
the tree and does **not** respect `.gitignore` — a committed fixture would run inside
every developer's bare `bun test` and cost them minutes. It lands outside the repo by
default, and the script refuses to write inside it, fatally, because it clears its
output directory before writing and could otherwise delete tracked files.

What it builds, and why each property is the thing under test:

- **Long**: 300 tests over 10 files, ~180s at the default sleep. Every test awaits one
  chain shared through `globalThis`, so wall-clock is `sleep × tests` whatever the
  runner's scheduling does — bun happens to run them sequentially, and a concurrent
  scheduler would otherwise collapse a naive per-test sleep.
- **Noisy**: `DUMMY_LINES_PER_TEST` [2] is the **volume** axis — lines of *its own*
  output per test. Not the whole story: the runner adds its own per-test lines, and
  whether it does depends on the **environment**, not only the terminal
  (`H1 <pty-shape>` in predictions.md; the answer is in results.md). The fixture's line
  counts are therefore measured *per environment* by the standing `pty-fixture` check,
  and the manifest records the environment. A line count quoted without its environment
  is meaningless.
- **Failing in the middle**: one planted test asserts a marker pair partway through, so
  no `head`/`tail` window reaches it and the failure's *position* is under test rather
  than its existence. `DUMMY_FAIL_FILE`/`DUMMY_FAIL_STEP` move it; the runner's
  file-discovery order decides where that lands in wall-clock terms, which the fixture
  reproducibility check measures rather than assumes.
- **Honest failure shape**: assertion, expected versus received, and a stack naming the
  generated file and line — so the volume a red run really produces is not understated
  by a two-line stub.
- **Knobs for the negative cells**: `DUMMY_FAIL_FAST=1` ends the run at the failure,
  which is the regime where a background job should have nothing to offer.

The script validates its own fixture: the planted failure must exist, or a run that
passed while the fixture claimed to fail would silently invalidate the measurement it
was made for. Its docstring documents each knob as an axis, and is the reference for
what a cell can isolate.

## Metrics

Taken from the session transcript by `bun scripts/measure-sessions.ts`, which is the
only instrument. Its columns:

| column | meaning |
|---|---|
| `execs` / `fg` / `handoff` | suite executions: foreground runs and job handoffs, counted separately |
| `blocked_s` | seconds the session spent waiting on a *foreground* suite run |
| `wall_s` | first to last transcript entry |
| `ctx_chars` | every non-empty text/thinking part in the transcript |
| `calls` | tool calls made |
| `diag` | whether the failure markers reached the final assistant text |
| `locating` | **the classification H7 needs**: the agent's first locating command, as `pattern` (`grep`, `sed -n '/…/…'`), `position` (`head`, `tail`, line-addressed `sed`), `full-read`, or `none` |
| `cause_reached` | **planned, not yet implemented** — what `trace-root` needs: whether the session opened or named the location the trace points at, and whether its answer carried the cause rather than the symptom. A presence-only metric cannot express this: a session can grep its way to a symptom perfectly, report it, and stop, and every existing column would look healthy |

`locating` is a small addition to the profiler, made in Phase 1 from the commands the
tool already records. Without it H7 could only be judged by reading transcripts, which
is how a hypothesis turns into an impression.

The split between column kinds matters, and the write-up must respect it:

- **Mechanism columns** — `fg`, `handoff`, `blocked_s` — are properties of the tool.
  A session cannot block on a job that runs detached; that is structural.
- **Agent columns** — `ctx_chars`, `wall_s`, `calls`, `locating` — are properties of
  the agent's *use* of the tool. They vary between runs of the same cell by design.

So: mechanism columns are evidence about bgrun. Agent columns are evidence about an
agent driving bgrun, and a single run of one is an anecdote. Report n≥3 with median
**and range**; a single run is labelled as one.

## Procedure

1. Freeze; confirm nothing else is running.
2. Probe the rungs for availability (one throwaway prompt each).
3. Generate the fixture, hash it, write the manifest.
4. Run the cell. Nothing else touches the machine until it finishes.
5. Profile the session directory with `measure-sessions.ts`.
6. Append the row to the cell's table, generated — never retyped.
7. Record the outcome against the cell's prediction: confirmed, falsified, or
   inconclusive.

**Run manifest** (beside each transcript): cell id · arm · context (including
pty/pipe) · **model, rung and reasoning effort** · the exact prompt · fixture id and
file hash · fixture knobs · session directory · start/end timestamps · machine load ·
anything else that ran concurrently.

## Case: the pty/pipe question — answered

**Was.** The theory: bun's reporter is terminal-aware, printing a per-test line on a
terminal and none through a pipe. If so the same suite would have two materially
different shapes, and every claim about output volume or about a window's chances of
reaching a failure would depend on which one was measured. An earlier round produced
inconsistent line counts for the same command and could not explain them, which is how
this stopped being academic.

**Is.** The theory is **falsified**. The real variable is the **environment**: with
`AGENT` or `CLAUDECODE` set — which is the environment a pi session runs in — bun
suppresses per-test lines in *both* shapes and the pipe and pty outputs are
byte-identical. Outside that environment, with a colour-capable `TERM`, per-test lines
appear in *both* shapes and differ only in format (`✓ name` on a pty, `(pass) name
[dur]` on a pipe), so neither shape is ever larger. The earlier discrepancy was the
environment, not the terminal.

**What it bought.** `pty-agent` is dropped — in an agent environment there is no shape
difference for an agent to react to, so the cell could not have measured anything.
`pty-fixture` stays as a **standing instrument check** run before a battery, because it
pins the output shape every other cell's numbers depend on, and the manifest now records
the environment. One hypothesis died before it could waste thirty sessions, which is the
argument for probing instruments instead of trusting them.

**Where the answer lives.** `scripts/pty-shape.ts`, its committed test, and
[results.md](./results.md).

## Case: unattended bgrun sessions

A bgrun cell is normally a real session with a human in it, which is why the battery
would otherwise be limited by someone's patience. The unlock under test (`H6 <unattended>`):
run `pi` **interactive in a pty** with the prompt as an argument — no `-p` — launched
so that nothing closes it. Interactive pi waits for input after its turn, so the
session is still alive when the job finishes and the wake has somewhere to land. The
harness harvests the transcript when the session settles and then ends the process.

That is a *method*, and a method that changes the thing under test is not allowed to
be assumed equivalent to the manual one. So, before any battery:

| | |
|---|---|
| runs | same cell, same fixture hash, same prompt: **n=2 manual + n=2 harness-held** |
| must match (mechanism) | job started as a job; blocked 0.0s; exactly one handoff; the session alive at job end; the wake delivered **as a wake**, not fetched as a tool result |
| may differ (agent) | wall, context, calls, locating strategy — these differ between two manual runs as well |
| criterion | the automated runs fall **inside the manual spread** on every mechanism column, and the wake arrives in both |
| falsifier | no wake; a wake-shaped tool result instead; a session that dies before the job ends; automated runs outside the manual spread |

If it fails, the fallback is a run-sheet: the bgrun cells are queued as prompts for a
human sitting, and the method says which cells were measured that way.

## Re-deriving a table

```
bun scripts/measure-sessions.ts /path/to/session-dirs… [--csv]
```

Rows cite the session directory, fixture hash and context from the manifest, so any
number here can be re-checked from the transcripts it came from.

## Limits, stated up front

- One machine, one checkout; mostly n=3, and three rungs only on the three ladder
  cells.
- Context is characters of transcript text, not billed tokens.
- The long fixture is synthetic. Real suites bring flaky tests, retries, parallel
  workers and enormous stack traces; the fixture brings none of them, and the doc says
  so wherever it matters.
- Live sessions are expensive to reproduce, which is itself a property of the tool
  worth naming.
