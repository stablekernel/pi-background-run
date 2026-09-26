# Dogfooding bgrun in this repo

This repo's maintainers run pi-bgrun on its own test suite. The setup is a
*personal* project config, not repo policy: `<project>/$CONFIG_DIR/pi-bgrun.json` is read
only for a trusted project, it changes what every `bgrun` job in the checkout
does, and one of its keys runs a shell command at wake time. So it is gitignored
here — copy the example below into your own working copy if you want the same.

```json
{
  "showCompletedJobs": true,
  "digest": [
    {
      "type": "test",
      "match": { "command": "*bun test*" },
      "label": "bun-test",
      "command": "grep -E '[0-9]+ (pass|fail)$' \"$1\" | tail -5"
    }
  ]
}
```

## What it does

- `showCompletedJobs: true` — finished jobs stay in `bgstatus` instead of
  disappearing (the extension's default is `false`). The live panel shows only
  running jobs; the status line holds the latest outcome.
- `digest[0]` — a **scorecard**: at wake time, for a job whose `type` is `test`
  *and* whose command matches `*bun test*`, the `command` runs with `$1` set to
  the job's log path, and its stdout is appended to the wake as
  `digest (bun-test): …`. Here that prints the suite's own pass/fail lines.

`jobsDir` is intentionally absent — `<project>/.pi-bgrun/jobs` is the default in
a repo, and the extension adds it to `.git/info/exclude` so logs never show up in
`git status`.

## Try it

Start the suite as a job and let the wake carry the scorecard:

```
bgrun(command: "bun test extension/index.test.ts", type: "test", name: "unit-tests")
```

The wake then carries the suite's own numbers instead of a summary the agent
has to re-derive:

```
finished (exit 0) …
digest (bun-test):  193 pass
 0 fail
```

(the scorecard is the digest command's stdout, exactly as printed — two lines
here, because `bun test` prints one per counter).

Selection rules that make this work: entries *declaring* a `type` are considered
first and only for jobs that declared that type, and an entry's `match` must pass
as well — so `type: "test"` with a command that isn't a `bun test` run falls
through to the type-less/glob pass (and, with no entry there, gets no scorecard).

## Overriding and unwinding

Config layers are `defaults ← user ← project ← env`, so an environment variable
beats the file (`PI_BGRUN_SHOW_COMPLETED=0`, `PI_BGRUN_MAX_LOG_BYTES=0`). To drop
the setup, delete `$CONFIG_DIR/pi-bgrun.json`; nothing else depends on it.

## How these numbers are produced

Every number below comes from a session transcript, not from an impression of
what the tool does. The method is fixed here so a later run is comparable to
these ones — and because a fixture we can tune is also a fixture we could tune
in our own favour, it is fixed *before* the runs, predictions included.

### The protocol

| element | definition |
|---|---|
| arms | **vanilla**: `pi -ne -ns` plus the provider extension. **bgrun**: the same, plus `-e extension/index.ts`. **vanilla-hinted** (control, below) |
| model | one provider and model per comparison (`bifrost-openai/fireworks/deepseek-v4.1-flash` here) |
| prompt | identical within a pair except the mechanism clause: `Run '<cmd>' in this repo and report the failure details.` vs `…as a background job with bgrun, and report the failure details once it finishes.` |
| sessions | **live** for every bgrun arm: a one-shot `pi -p` exits before the wake is delivered, so those runs need a human present. Vanilla arms block and report on their own, so they are scripted |
| samples | 3 per arm, reported as median **and** range. A single run is stated as such |
| metrics | from the transcript: suite executions, blocked-on-output, idle, session wall, context chars, per-call (wait, size), the exact commands, and whether the failure diagnostic reached context at all |
| re-derive | `bun scripts/measure-sessions.ts <session-dir…>` — the committed profiler, so any table here can be recomputed from the transcripts |

The **vanilla-hinted** control matters: it asks vanilla pi to redirect the run to
a file and grep it. That is the technique bgrun implements, hand-rolled by the
agent, and it is the strongest baseline in the set — if bgrun cannot beat it, the
tool is a convenience rather than a capability.

### Pre-registered expectations

Written down before the runs, including the cells where the tool is expected to
*lose*. Cells that contradict their prediction are findings, not failures to
explain away.

| cell | scenario | predicted winner | of what, and what would falsify it |
|---|---|---|---|
| R1 | the repo's own suite: green, 224 tests, ~22s, ~340 lines | **vanilla** | nothing blocks and the output is small; bgrun adds a job, a wake and a read. Falsified if the digest makes the bgrun session cheaper overall |
| R2 | red, failure **78–90 lines from the end** | **vanilla** | a `tail -40` window hits it, one call, no wait — the pytest/jest shape |
| R3 | generated suite: ~180s, ~2,760 lines, failure 65% through | **bgrun** | no window reaches the failure, so vanilla buys a second full run. Already measured below |
| R4 | **same volume, no time**: generated with `DUMMY_SLEEP_MS=20`, `DUMMY_LINES_PER_TEST=8` | **bgrun** on completeness, **vanilla** on cost | isolates volume from duration. If one or two greps find the failure, vanilla is cheaper and bgrun's advantage is time, not size |
| R5 | **fail-fast**: `DUMMY_FAIL_FAST=1`, the run collapses at the failure | **vanilla** | when a failure ends the work early the blocking cost is small, and the wake is pure overhead |
| C1 | start the long suite, then do an unrelated ~60s task in the same session | **bgrun** | overlap is the actual niche: wall ≈ max(180, 60) against 240. **Falsified if the agent waits anyway** — a plausible outcome worth measuring |
| C2 | three long suites at once | **bgrun** | a foreground agent serialises them (≈3 × 180s); jobs run concurrently |
| C3 | restart the session mid-run | **bgrun** | the log outlives the session; a foreground run's output dies with it |
| C4 | "which part is it on right now?" | **bgrun** | `bgtail` answers mid-run; a foreground command cannot be asked |
| D1 | a weaker or faster model | **unknown** | hypothesis: if bgrun's value is reliability (no guessing, no re-running), it should grow as the agent weakens. If the advantage holds only for the strong model, that story is wrong |

C1–C4 are dialogues rather than fixtures: no generated suite can express them,
because the thing under test is what the session does *while* a job runs and what
survives afterwards.

### The fixture, and why it is shaped that way

`bun run bench:make-suite` generates the long, noisy, failing suite
(`scripts/make-dummy-suite.ts`). It is generated rather than committed because
`bun test` discovers `*.test.ts` anywhere in the tree and does **not** respect
`.gitignore` (measured) — a committed fixture would run inside every developer's
bare `bun test` and cost them minutes. So it defaults outside the repo, and the
script refuses to write inside it, fatally, because it clears its output
directory before writing and could otherwise delete tracked files.

What it builds, and why each property is the thing under test:

- **Long**: 300 tests over 10 files, ~180s by default. Every test awaits one
  chain shared through `globalThis`, so wall-clock is `sleep × tests` whatever
  the runner's scheduling does — bun 1.3.6 happens to run them sequentially, and
  a concurrent scheduler would otherwise collapse a naive per-test sleep.
- **Noisy**: each test logs a tunable number of lines. The default is **realistic**
  (2, against bun's own ~1.5 lines per test); `DUMMY_LINES_PER_TEST=8` reproduces
  the verbose density the earliest measurements here used, which matters when
  comparing against them.
- **Failing in the middle**: one planted test asserts a marker pair at 65% of the
  run, so no `head`/`tail` window reaches it and the failure's *position* is under
  test rather than its existence.
- **Honest failure shape**: the failure block looks like a real assertion failure
  (assertion, expected vs received, stack) rather than a two-line stub, so the
  output volume a red run really produces is not understated.
- **Knobs for the negative cells**: `DUMMY_FAIL_FAST=1` ends the run at the
  failure, which is the regime where a background job should have nothing to
  offer; `DUMMY_FILES`/`DUMMY_TESTS_PER_FILE`/`DUMMY_FAIL_FILE`/`DUMMY_FAIL_STEP`
  move the size and the failure's position.

The script validates its own fixture: the planted failure must exist, or the
generated run would silently invalidate the measurement it was made for.

### What this method cannot see

- It is one machine, one checkout, one model, and mostly n=3. The spread across
  runs is large enough that single numbers are anecdotes.
- Context is counted in characters of transcript text, not billed tokens.
- The fixture is synthetic. Real suites fail in ways this one does not: flaky
  tests, skips, retries, parallel workers, enormous stack traces.
- Live sessions make bgrun's cells expensive to reproduce — a reviewer cannot
  re-run them unattended, which is itself a property of the tool worth naming.
- The metrics split into two kinds, and only one is stable: **executions and
  blocked time are the mechanism's** (the agent cannot block on a job that runs
  detached), while **context and wall-clock are the agent's** (it chooses what to
  read and when to look). Stable columns are evidence about `bgrun`; unstable
  ones are evidence about the agent's use of it, and the reports below say which
  is which.

## Measured effect on context

Three ways the same suite run (`bun test extension/index.test.ts`, 224 tests,
~22s) lands in a pi session. Every arm: same provider and model
(`bifrost-openai/fireworks/deepseek-v4.1-flash`), same checkout, extension
discovery off (`-ne`) with only the provider extension loaded — plus this repo's
extension in the bgrun arm.

| arm | prompt | what pi chose | context chars |
|---|---|---|---|
| C | "run this **exact** command with your bash tool" | the command bare, blocking | **21,176** — one tool result carrying the full 241-line output (21,005) |
| E | "run it and tell me whether it passed" | `bun test … 2>&1 \| tail -40`, blocking | **3,530** — last 40 lines only |
| D | "start it as a background job" | `bgrun`, woke on the digest, one 60-line `bgtail` | **6,127** — full log still on disk |

**Arm E, not arm C, is the naive baseline.** Asked neutrally, an agent bounds the
output itself with `| tail -40`; arm C is what a directive prompt produces. So the
claim is not "fewer context characters" — against a tail-ing agent bgrun costs
*more* context (6,127 vs 3,530) and buys instead:

- the session is not blocked for the run;
- the exit status is real: `cmd | tail -40` reports *tail's* status, not the
  command's, so a red suite reads as green (measured: direct run exit 1, piped run
  exit 0);
- nothing is truncated: exit code, stats, and all 240 log lines survive on disk,
  where `| tail -40` discards everything before the last 40 lines. Runners that
  print failures *in place* (bun, go, make) leave the failure diagnostic above
  that window — the summary still names the failing test, so what is missing is
  the *reason*, and a capable agent gets it back by running the suite again (see
  [When the suite fails](#when-the-suite-fails) below);
- the wake carries the digest (`224 pass / 0 fail`) in 368 characters, so the
  common case needs no read at all;
- further reads are bounded and incremental — delta `bgtail`, capped `bggrep`.

"Context chars" counts every non-empty `text` and `thinking` content part in the
session JSONL, so tool output counts wherever a provider files it: the same
experiment with the full extension set on the `cursor` provider put the identical
~21 KB in a `thinking` part rather than a tool result (21,522 vs 10,054 across that
pair — not a controlled comparison, only a cross-provider sanity check).

Caveats for the table above: n=1 per arm, one suite. The bgrun arm's 2.5 KB read is
the agent's own choice, so a session that reads more of the log narrows the context
gap by design — that is the escape hatch working, not a measurement flaw. The
failure pair below is n=3 per arm.

### When the suite fails

Same setup and the same ask ("report the failure details"), but every run in a
**live session** — a one-shot harness cannot hold a session open for the wake, which
is why this pair is measured by hand. Identical command: the repo's suite plus a
fixture whose first test fails — 340 lines, 23 s, exit 1, with the failure
diagnostic at lines 250–262, i.e. **78–90 lines from the end**. Three runs per arm:

| | vanilla pi | bgrun |
|---|---|---|
| suite executions | 3, 4, 1 — median **3** | 1, 1, 1 — median **1** |
| blocked waiting on output | 66.0s, 45.4s, 22.1s — median **45.4s** | 0.0s, 0.0s, 0.0s |
| session wall | 81.6s, 56.5s, 31.8s — median **56.5s** | 32.9s, 29.3s, 33.6s — median **32.9s** |
| context chars | 23,597, 12,791, 4,722 — median **12,791** | 6,277, 10,603, 7,087 — median **7,087** |
| diagnostic reached context | yes, all three | yes, all three |

The spread is the agent guessing where the failure sits. Vanilla's three runs each
opened with a different window, against the same command:

| run | first window | hit | executions | context |
|---|---|---|---|---|
| 1 | `… \| head -200` | no | 3 | 23,597 |
| 2 | `… \| tail -60` | no | 4 | 12,791 |
| 3 | `… \| tail -100` | yes | 1 | 4,722 |

`tail -100` reaches past line 250; `tail -60` does not; `head -200` misses *and*
carries 17.6 KB of the wrong output. So a run costs one execution or four depending
on a guess, at 22s per losing bet. bgrun never varied — one execution, nothing
blocked, ~30s, every time — because **the log removes the guess**: whatever window
the agent picks, the output is still there to read.

Two honest notes. bgrun's *best* case is not better than vanilla's: run 3 was
cheaper (4,722 chars against bgrun's 6,277–10,603) and about as fast. What bgrun
buys is the absence of the bad case — 4 executions, 82s, 23.6 KB — not a better
median. And the position of the failure is what makes it a guess: a runner that
summarises failures at the very end (pytest, jest) would be hit by `tail -40` every
time.

### When the suite is long and noisy

The repo's own suite is 340 lines in 22s — neither. This section uses a generated
one (`bun run bench:make-suite`, see `scripts/make-dummy-suite.ts`): 300 tests over
10 files, ~180s, ~2,760 lines, failing 65% of the way through so no `head`/`tail`
window reaches it. Nothing about the command telegraphs its volume. Note the
density, though: this run used the fixture's then-default of 8 log lines per test,
which is *verbose* — bun's own reporter prints ~1.5 lines per test, which is what
the generator now defaults to. So the volume here is an upper bound on what a real
300-test suite emits; the R4 cell exists to separate volume from duration. One run
per arm, both in live sessions:

| | vanilla pi | bgrun |
|---|---|---|
| suite executions | **2** | **1** |
| blocked waiting on output | **359.9s** | **0.0s** |
| session wall | 372.7s | 189.4s |
| tool calls | 4 | 5 |
| context chars | 10,016 | 8,049 |
| failure found | yes | yes |

Vanilla opened with `… 2>&1 | head -100` — the first ~4% of the run, while the
failure sits at 65% — so it paid a **second full 180s execution** into a file before
it could grep and slice the block. bgrun ran the suite once, took the wake when it
came, and read the log afterwards.

Worth noting on the bgrun side: two of its five calls came *before* the wake —
`bgstatus` (200 chars) and a 40-line `bgtail` (2,031 chars), together **28% of its
context**, spent learning what the wake then delivered for free. That is the
behaviour the guidance now discourages: do not poll a job you just started.

## Where bgrun helps, and where it does not

The summary the measurements above actually support — kept separate from the
sales pitch, because the interesting boundary is where the tool stops paying for
itself.

### Where it helps

- **Long runs.** The blocking cost scales with runtime, and a losing guess costs
  another whole run: on the 180s fixture, vanilla spent **359.9s** waiting across
  two executions while bgrun spent **0.0s** across one.
- **Output no window reaches.** The failure at 65% of 2,760 lines is invisible to
  `head`/`tail`; a log on disk is still complete after the fact, and `bggrep`
  addresses it.
- **Doing something else meanwhile.** The genuine niche, and the least measured
  cell so far (C1): a job runs while the session works on something else, and
  three jobs run at once where a foreground agent can only serialise them (C2).
- **When the session might not survive the run.** The log outlives the session:
  a restart, a resume, a later session, or another agent can still read it, where
  a foreground run's output is gone with the context that held it (C3).
- **Asking about a run in progress** — `bgtail` mid-run (C4); a foreground command
  cannot be asked where it is, only finished.
- **When nobody wants to read the log at all.** The digest puts `224 pass / 0 fail`
  in the wake in 368 characters, which is the common case needing no read.

### Where it is weak, or not obviously better

- **Against an agent that bounds its own output.** Asked neutrally, pi runs
  `| tail -40` and spends **3,530** chars; bgrun spent **6,127**. bgrun costs
  *more* context in the simple case — it buys non-blocking and completeness, not
  economy.
- **When the failure is at the end of the output.** pytest and jest summarise
  where the tail already reaches, so one call hits it with no wait (R2).
- **Against an agent that hand-rolls the technique.** In R3, vanilla's second
  execution redirected to a file and grepped it — that *is* bgrun's mechanism,
  reached without the tool. What remains is convenience: the wake, the exit
  status, the bookkeeping, the bounded reads.
- **Short commands.** Nothing to overlap mid-run and nothing worth surviving; the
  tool's own guidance says not to bother.
- **Fail-fast runs** (R5): the failure ends the work early, so there is little
  waiting to avoid and the wake is overhead.
- **For a human at a terminal.** `&`, `tmux`, a split pane, or just watching it
  covers the same ground. The advantage is specific to an agent that shares one
  context and cannot see a background process unless it is told. In CI, none of
  this applies.
- **The tool's own papercuts, found by measuring it** — which is the argument for
  measuring: a pre-wake poll cost **28%** of one bgrun session's context (the
  guidance now discourages it, #27); `bggrep` line numbers were window-relative,
  not file-relative (#25, open); re-reading a log re-paid for the same lines until
  delta `bgtail` shipped (#4).

The strongest defensible version of the claim is the one the data shows: bgrun
does not make the best case better — vanilla's `tail -100` run beat every bgrun
run on cost — it removes the worst case, which is an agent guessing a window four
times into a 180-second command. Where a session can afford to wait, or the
failure sits where a tail finds it, plain `bash` is the better tool.

## See also

- README: [Digest scorecard (opt-in)](../README.md#digest-scorecard-opt-in) — the
  full selector reference, presets (`go-test`, `jest`, `pytest`, `junit-xml`), and
  the `custom`/`output` forms.
- The `digest-config` skill — samples a project's real logs, drafts a digest
  command, and validates it against green *and* red runs before writing the file.
- The per-project nudge: until a project has a digest, bgrun mentions the option
  once (a `.bgrun-used-<hash>` marker in the jobs dir records that it happened).
