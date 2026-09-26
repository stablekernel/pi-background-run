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
window reaches it. Nothing about the command telegraphs its volume. One run per arm,
both in live sessions:

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

## See also

- README: [Digest scorecard (opt-in)](../README.md#digest-scorecard-opt-in) — the
  full selector reference, presets (`go-test`, `jest`, `pytest`, `junit-xml`), and
  the `custom`/`output` forms.
- The `digest-config` skill — samples a project's real logs, drafts a digest
  command, and validates it against green *and* red runs before writing the file.
- The per-project nudge: until a project has a digest, bgrun mentions the option
  once (a `.bgrun-used-<hash>` marker in the jobs dir records that it happened).
