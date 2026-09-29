# Benchmark: does backgrounding a long command pay the agent back?

`bgrun` exists so an agent session stays unblocked while a long shell command runs, and
so the command's output never enters the conversation. The question this benchmark was
built to answer is narrower than that promise: **does handing a long command to the
background cost the agent more than it saves?**

The answer depends on the job, and that split is the headline. This document states what
the measurements support and what they do not. It is a summary of a week of measurement;
every number comes from a named cell, and the record behind each one — the procedure,
the predictions written before the runs, the per-cell transcripts — is listed under
[Provenance](#provenance).

**In a hurry?** [`docs/benchmark/AT-A-GLANCE.md`](docs/benchmark/AT-A-GLANCE.md) is the
same case in a few minutes: one section per measured cell (what it tested, the bgrun-versus-
vanilla numbers, and what each arm's agent actually did), where bgrun does not help, and the
three-way pointer result. This document is the full treatment behind it.

## How a cell is run

A cell is a **fixture × arm × context** at one model. The `bgrun` arm runs this repo's
extension; the `vanilla` arm runs the same session without it. Both arms get the same
neutral prompt — run this and report the failure details — so that reaching for the tool
is a finding rather than an instruction. Sessions are live (a wake needs a session that
still exists when the job ends), the model is `anthropic/claude-sonnet-4-6`, and each arm
is run three times (n=3). Reported figures are medians, with the run range in brackets.

Mechanism columns (`blocked_s` — seconds the session spent waiting on a *foreground* run,
`execs`, `handoff`) are properties of the tool. Agent columns (`wall_s`, `ctx_chars`,
`calls`) are properties of an agent driving it and vary run to run by design. `ctx_chars`
counts characters of transcript text, not billed tokens. Source: `method.md`.

**Limits, stated here rather than in a footnote.** n=3 per arm; one model; one fixture
family; one machine. The fixture is synthetic — it has no flaky tests, retries, parallel
workers or enormous stack traces. Three runs demonstrate an effect; they do not
generalise, and no significance is claimed anywhere in this document. The numbers
quoted with a caveat are Cell 4's two pointer runs, and the caveat is stated with each.

## The regime split

The cost of the background arm is the wake's round trip: the job runs detached, but the
session must still wait for the wake before it can act. Whether that is cheaper than
running synchronously depends on how long the job takes.

| | Cell 3a — cheap job (current) | Cell 4 — expensive job |
|---|---|---|
| job | 22.8s | ~204s (570 tests, 1,281 lines) |
| `wall_s` | 40.7 [39.2–43.9] vs 34.5 [33.2–34.6] | **225.9** [223.1–228.4] vs 696.2 [283.8–732.4] |
| `blocked_s` | 0.0 vs 22.8 | **0.0** vs 660.2 |
| `ctx_chars` | 14,009 vs 29,721 | **18,760** [16,365–21,056] vs 79,901 [66,792–86,836] |
| `calls` | 3, 3, 3 vs 1, 1, 1 | 3, 4, 4 vs 12, 2, 6 |

**For a cheap job (23–34s) the background arm is slower — the arm's own turns around the wake
cost, not the wake's arrival.** Cell 3a's job is 22.8s and the wake lands within **milliseconds**
of it exiting (4ms, per `runs/trace-root-framewake/sessions/bgrun-*`) — the same millisecond
delivery every post-fix cell shows. The **~7–8s** the earlier framing charged to the wake belongs
to Cell 1, the pre-poll-fix run, where the session held its turn open polling and the wake waited
for the turn boundary (`runs/red-tail-short/CELL.md`:117,119); it is an extra cost of the polling
bug, not of the wake. So the arm's wall is the job plus its own turns around the wake — 40.7s
against vanilla's 34.5s, the same job blocked once in a single call. The arm still delivers
what it owns — `blocked_s` 0.0 against 22.8s — but the unblocking is paid for in session
wall time. Source: `runs/trace-root-framewake/CELL.md`.

**`red-tail-short` — the same cheap job on the current tool.** The second short cell measures
the same shape: on 0.8.0 (Cell 1c, `runs/red-tail-short-v080/CELL.md`) the arm is 46.7
[40.3–50.7] against vanilla's 35.0 [34.4–38.6], with context 13,941 [12,876–16,534] against
30,056 and calls 4, 3, 3 against 1, 1, 1; no session polls a running job
(`blocked_s` 0.0 against 24.3, wake claims 0, 0, 0). It is negative on wall for the same
floor reason — the job is ~24.4s and the arm pays it plus its own turns around the wake —
and, as in every short cell, the unblocking is paid for in session wall time.

**The wake's closing-line change costs the same increment here as in the `trace-root` pair**
(Cell 3 → Cell 3a). Against the pre-framing Cell 1b, **calls rise 2 → 3–4 and context 9,892 →
13,941**, because the closing line points at the log and the session now opens a window on it
(`bgtail`) instead of answering from the summary — the same one-step sequence change the
`trace-root` pair shows.

**Before the wake's closing line changed** (labelled history). Two earlier runs measured the
same shape on builds that predate the change: `red-tail-short`'s Cell 1b (the poll fix,
pre-framing) at 40.9 [38.1–42.7] vs 33.5 [32.3–33.9] with context 9,892 against 28,021
(`runs/red-tail-short-fixed/CELL.md`), and `trace-root`'s Cell 3 at 37.5s against 34.5s
(`runs/trace-root/CELL.md`). Each is kept as labelled history inside its own cell section,
never as a competing headline. Cell 1b is also the poll fix's own success — it drove the
fabricated wake and the polls it licensed to zero — but the current red-tail measurement is
Cell 1c above.

**For an expensive job the background arm pays it once and the synchronous arm pays it
repeatedly.** Cell 4's job takes ~204s. The `bgrun` arm's 225.9s is that job plus about
22s of agent work, with `blocked_s` 0.0; the vanilla arm's 696.2s is the session choosing
to run the suite again (4 foreground runs median, `blocked_s` 660.2, and the
283.8–732.4 spread is that choice). That is 3.1× faster and 4.3× lighter — and the
diagnosis is a tie: both arms reach `part-05.test.ts`, which is the best form of the
result, the same answer at a quarter of the context because vanilla bought it by reading
everything. Source: `runs/long-buried/CELL.md`.

## The load-bearing change was two sentences of framing, not ecosystem parsing

The `trace-root` fixture puts the failure's *cause* in a file of its own (`harness.ts`),
reachable through a stack frame that the failure's own wording does not mention.

- **Cell 3** (`runs/trace-root/CELL.md`) closed every wake with *"the exit code, stats
  and last output above **are the result**"*. The `bgrun` arm's pattern search therefore
  looked for failure words, which match the assertion but not the frame line
  (`at loadStep (.../harness.ts:28:9)` contains no failure word). `harness.ts` appeared
  in the `bgrun` arm's context **0 of 3** runs, against **2, 2, 2** for vanilla. Vanilla's
  single synchronous read carries the whole log. This is the correction the record
  carries: the mechanism was the wake's *framing*, not a digest — **no digest was
  configured for that project**, so the wake carried no digest block at all. The
  `H9 <digest-starves>` hypothesis therefore gains nothing from this cell; its only
  recorded entry remains the narrow one in `results.md`, where a digest built from a
  counts-only command carried `299 pass`, `1 fail` and nothing else.
- **Cell 3a** (`runs/trace-root-framewake/CELL.md`) re-ran the same cell, same fixture
  (bytes and all), same model, same prompt, with **only the closing line changed** to *"a summary,
  not the diagnosis — the log holds the detail… read a window around the failure before
  concluding a cause."* Nothing else changed: no digest, no preset, no pointer. The
  frame file now appeared **3, 3, 5** times, the deepest frame seen became `harness.ts`,
  and the call sequence gained one step (`bgrun` → `bggrep` → `bgtail`) — the extra call
  cost ~4k characters and bought the cause, still at **half vanilla's context** (14,009
  against 29,721). The wall floor stands (40.7s against 34.5s).

The instruction knows nothing about how any runner spells a stack frame, which is the
point: the fix is language-neutral instruction, not ecosystem-specific parsing. The
JS/TS-tuned built-in locator was deleted in favour of this framing plus optional presets,
and a nine-entry multi-runner corpus re-run showed nothing regressed (merged as `6b04d24`).

## A pointer is a lead the session still has to verify — and that costs

The presets and the `on: "failure"` gate put a *pointer* — a named failure and its source
frame — in the wake. Cell 4 ran that layer three ways, each run changing one thing
(`runs/long-buried/CELL.md`, profiles beside it):

| Cell 4, bgrun arm | pointer, correct (current) | no pointer (baseline) | pointer, wrong (before the fix) |
|---|---|---|---|
| `calls` | 5, 5, 8 | 3, 4, 4 | 5, 5, 6 |
| `ctx_chars` | 33,799 [29,180–36,355] | 18,760 [16,365–21,056] | 28,633 [21,867–31,481] |
| `wall_s` | 234.0 | 225.9 | 233.1 |

Ranges do not overlap on calls (baseline max 4, both variants min 5) or context (baseline
max 21,056, correct variant min 29,180). Both variants reached the same
`part-05.test.ts`.

**Current run — the pointer was fixed and still cost more.** After the preset required
anchored evidence, all three wakes named the true failure
(`AssertionError … at TestContext.<anonymous> (/private/tmp/long-buried-fixture/part-05.test.ts:59:9)`),
and the cost rose again, not fell. The sequences say why: `bgrun bggrep bggrep bgtail bggrep`
— every session *verified* the pointer and searched anyway, doing more work than a baseline
which had nothing to verify. `calls_after_exit` is 4, 4, 6 against the baseline's 2, 2, 3.
The wake's own honest hedge — *"any failure named here (by a trace digest) is one failure,
not the whole story"* — makes a pointer a lead rather than an answer, and dropping that hedge
to make the pointer land would be tuning the instrument to the result.

**Before the fix — the pointer was wrong** (labelled history, the superseded `js-trace`
preset). The layer's first behavioural exercise named
`Failure: (pass) preset js-trace corpus (captured): …`, **a passing test's name**. The
cause is self-reference: the suite under test contains the preset's own corpus tests,
which print captured failure text, so the log holds failure-shaped strings from passing
tests, and an unanchored scanner cannot tell them from a real one. Sessions did not trust
it, and that wrong-pointer run is the most expensive after the fixed one: 5, 5, 6 calls
and 28,633 characters.

**The rule: a pointer is a hypothesis the session must still verify, and where it can search
cheaply that costs more than it saves.** Its value should be conditional on the session
*lacking* a cheap search — a log too large or too hostile to grep, a tool-less agent, or a
weaker model, which is `H7`/`H8`'s territory. The defect fix stands on its own merits
(conservative emission: say nothing rather than guess). Attribution caveat: this workload is
the extension's own test suite, a pathological digest input, so the *rule* generalises further
than the *number* does.

## The layer boundary

The through-line of this work is a boundary between what the framework owns and what the
project owns. The framework owns facts it can prove: the exit code, the job's state,
whether the job is still running. The project owns everything that depends on how *its*
tooling spells failure — what a stack frame looks like, what a failing test prints,
whether a log is red. Three decisions in this work are instances of holding that line:

1. **The ecosystem-specific locator was deleted.** A default tuned to the product's own
   runner (measured over the nine-entry corpus, it worked on 2, both JS/TS) is gone;
   Cell 3a shows a language-neutral instruction did better than the JS-tuned regex.
2. **No "did this digest produce a failure signal?" heuristic was added.** That judgement
   would require per-ecosystem knowledge of what a failure looks like, so the framework
   does not attempt it; the only thing it enforces is the fact it can prove — a digest
   block gated on `"on": "failure"` is appended only for a non-zero exit, because the
   digest command itself never sees the exit code.
3. **The tool never writes a project's config files.** When a project has run a bgrun job
   and has no digest configured, the nudge points at the `digest-config` skill rather
   than writing `.pi/pi-bgrun.json` itself: sampling a project's real logs and choosing a
   scorecard is project-owned work.

## Robustness: no polling, no false wakes

In every measured cell, the `bgrun` sessions made **zero polls before the wake** and
**zero wake claims they had not received** (`0/0` in all three Cell 4 baseline sessions,
all three Cell 4 pointer-variant sessions, all Cell 3a sessions, and all three Cell 1c
sessions). Cell 1 was the counter-example that produced the fix — 3 of 3 sessions claimed a
wake before receiving it and made 10, 9 and 5 polls — and Cell 1b re-ran the same cell on the
fixed extension and measured 0, 0, 0 in both columns
(`runs/red-tail-short-fixed/CELL.md`); Cell 1c re-ran it again on 0.8.0 and measured the same
0, 0, 0 (`runs/red-tail-short-v080/wake-claims.csv`), so the fix holds on the current tool.
This holds in Cell 4, a 1,281-line log and a ~204s job, which is the cell where polling is
most tempting. It is a mechanism result about the tool, not a claim about agents in general.

## What the results do not establish

- **`H11 <trace-depth>`** — that reaching a root cause is a capability boundary — is
  **not tested**. Cell 3's `cause_reached` flag reads 1 in both arms for definitional
  reasons (it is session-relative: the deepest frame *that session saw*), so it must be
  read together with `cause_file`. Testing `H11` needs the capability ladder
  (haiku → sonnet → opus), and only the mid rung has run.
- **`H9 <digest-starves>`** gains nothing from Cell 3 or 3a: no digest was configured
  there. Its only recorded entry is the counts-only digest in `results.md`; the only
  later cell with a digest configured is Cell 4's pointer variant, which is about the
  pointer rather than about a session trusting a count-only digest.
- **The capability ladder (`H7`, `H8`) and the dialogue cells** (`overlap-task`,
  `parallel-jobs`, `resume-midrun`, `peek-midrun`, `fast-verbose`, `fail-fast`,
  `green-short`) are **not run** — see the status table in `results.md`. Nothing in this
  document speaks to them.
- **Whether the pointer *adds* diagnostic value on top of the framing** is answered in the
  negative *for this regime*: with the preset corrected, the pointer cost more than no
  pointer — calls 5, 5, 8 and context 33,799 against 3, 4, 4 and 18,760 — because the
  session verified it and searched anyway. What is still not in the record is a project
  whose suite does not contain the preset's own corpus, or a session without a cheap
  search. That is why the rule is stated as conditional rather than the layer removed.
- **Unattended cells are impossible on this setup** (`H6 <unattended>`: negative), so
  every cell above was driven with a human in the session. That bounds what may be claimed
  for them, and it is a method difference between cells, not a footnote.
- **One engine of the observed cause-loss is unexplained.** In Cell 3 the `bgrun`
  answers cited line numbers that belong to `harness.ts` while `harness.ts` appeared in no
  session's context. The records leave how those numbers arrived as an open question
  rather than a story.

## Provenance

The full record lives in the adjacent benchmark checkout, `pi-bgrun.bench-doc`, under
`docs/benchmark/`:

| file | what it holds |
|---|---|
| `method.md` | how a cell is run and what its numbers mean (arms, contexts, metrics, controls) |
| `predictions.md` | every hypothesis prediction written before the runs — tested outcome, or untested registration |
| `results.md` | the running record the cells cite |
| `runs/<cell>/CELL.md` | one cell's numbers, mechanism and limits |
| `runs/<cell>/profile.csv` | the per-session rows, generated by `scripts/measure-sessions.ts` |

Cell → record path: `red-tail-short` (Cell 1) `runs/red-tail-short/CELL.md`;
`red-tail-short` after the no-poll change (Cell 1b) `runs/red-tail-short-fixed/CELL.md`;
`red-tail-short` on 0.8.0 (Cell 1c, the current tool) `runs/red-tail-short-v080/CELL.md`;
`trace-root` (Cell 3) `runs/trace-root/CELL.md`; `trace-root` with the framing fix
(Cell 3a) `runs/trace-root-framewake/CELL.md`; `long-buried` and its pointer variants
(Cell 4) `runs/long-buried/CELL.md`, `runs/long-buried-tracepreset/CELL.md` and
`runs/long-buried-tracepreset-fixed/CELL.md`;
the attended-method pilot `runs/pilot/MANIFEST.md`. The instrument checks that decided
whether these cells' numbers mean anything are in `results.md` (the pty/pipe shape check,
which falsified its own hypothesis, and the trace-path check).
