---
name: run-bg
description: Use when running any long or verbose shell command (make test, go test ./...,
  make lint, builds) so output lands in a file instead of flooding context and the session
  stays unblocked. Start the job, hand control back, check status later, and read only a
  tail or a code-processed summary of the log.
---

# Run in Background (pi-bgrun)

Run long/verbose commands detached. Output → file. Context stays clean; the session
never blocks. The extension wakes this session automatically when the job finishes —
no polling.

Host-relative paths: `$AGENT_DIR` is the user-level agent directory (`~/.omp/agent`
under oh-my-pi, `~/.pi/agent` under pi) and `$CONFIG_DIR` is the project config
directory (`.omp` under oh-my-pi, `.pi` under pi). The jobs dir
(`.pi-bgrun/jobs`) is shared by both hosts and does not vary.

Host features: the **Native background jobs (oh-my-pi)** section and the `native`
rows in `bgstatus` / the live panel apply only to oh-my-pi. On pi there is no
host-managed background path — every background job is a bgrun job.

## When to use

- Any command expected to run > ~30s OR emit > ~100 lines.
- Typical: `make test`, `go test ./...`, `make lint`, `make build`.
- Integration / infra suites (long-running, always background).

The two thresholds measure different things: **> ~30s** is about the session
staying unblocked, **> ~100 lines** is about context — output that reaches you as
a tool result stays in the transcript for the rest of the session, and a bgrun
log never does.

## When NOT to use

- Commands that complete in < ~5s — the overhead isn't worth it.
- Short, quiet commands whose full output you actually need (`git status`).
- Interactive commands (prompts, REPL, SSH) — bgrun detaches from the terminal.

## Where the wake lands

A job's completion wake goes to the session that started it. In normal use that
is the main session, and the wake starts a turn there.

**Inside a `task`/subagent session, do not start long jobs.** The wake is
addressed to that subagent, which has usually already returned by the time a long
job finishes, so nobody gets woken — the job runs to completion silently. The log
still lands in the project's jobs dir, so `bgstatus <id>` / `bgtail <id>` can read
it from the main session afterwards; only the notification is lost. Prefer
starting long jobs from the main session, or run the command directly (blocking)
when you are inside a subagent and need the result.

## Native background jobs (oh-my-pi)

oh-my-pi backgrounds long `bash` calls by itself (`bash.autoBackground`, and an
explicit `async: true`) and delivers the result automatically as an async result.
Those jobs are **not** bgrun jobs: their ids look like `bg_1`, they are cancelled
when the session is switched or replaced, and bgrun never starts, adopts or
cleans them. `bgstatus` lists them too, marked `native`, and `bgtail` / `bggrep`
resolve a `bg_N` id (see below) rather than dead-ending on it.

- Their output is delivered to you automatically — do not poll for it.
- When the host truncated the output, it spilled the full text to a session
  artifact; `bgtail bg_3` / `bggrep bg_3` read that back through the same bounded
  readers used for bgrun logs (the read is stamped as the host's file, not ours).
  If nothing was spilled, the id says so — it never invents a path.
- They belong to the host: to kill one, use oh-my-pi's own `hub cancel ids:["bg_3"]`
  (see `hub jobs`, or `/jobs` for a human). `bgkill` refuses them for that reason,
  and the two namespaces keep separate lists and separate kill switches
  (`bgstatus`/`bgkill` for bgrun's, `hub jobs`/`hub cancel` for the host's).

Which to use:

- **Native bash background** — a long command whose output you will read once, in
  this session, and never need again.
- **`bgrun`** — a job whose log must outlive the session: surviving a restart or a
  crash, greppable on disk afterwards (`bgtail` / `bggrep`), scored by a digest,
  or visible from another session in the same project.

## Tools

| Action | Tool |
|---|---|
| Start  | `bgrun(command: "make test-short", name: "unit-tests", type: "test")` → `started: <job-id>` (name is an optional short label; use it so jobs are recognizable in `bgstatus`, the live panel, and wake messages) |
| Status | `bgstatus(<job-id>)` for one job, or `bgstatus()` for this session's running jobs — finished jobs are hidden by default; pass `includeDone: true` to list them |
| Tail   | `bgtail(<job-id>, 40)` — first read: last-40 tail; later reads: only lines appended since (delta tailing) |
| Grep   | `bggrep(<job-id>, "pattern", context?)` — line-numbered matches, capped and condensed; default pattern = generic failure signatures (override when you know the format) |
| Clean  | `bgclean()` for this session's old logs; `bgclean all` to sweep every session's (default 7-day retention) |
| Kill   | `bgkill(<job-id>)` — SIGTERM to the job's process group; `force: true` for SIGKILL. Refuses finished ids, non-bgrun ids, and another session's job unless `includeForeign: true` |

## Workflow

1. **Start:** call `bgrun` with the command (and a short `name`, e.g. `name: "unit-tests"`).
   When the project's digest config defines `type` entries, also pass the
   matching `type` (e.g. `type: "test"`) — like `name`, it helps the wake
   select the right digest scorecard. You do not have to go looking for the
   vocabulary: when a digest is configured and you omit `type`, the `started:`
   result names the configured types. Note the returned job-id. Continue other
   work; you will be woken automatically when the job finishes.
2. **On wake:** check the exit status in the wake message first.
   - `exit: 0` → success. `bgtail` to confirm.
   - `exit: <non-zero>` → failure. Analyze the log (see below).
3. **If you need to check before the wake (non-blocking):** call `bgstatus` with the job id.
   - `running` → keep doing other work. Do NOT spin a wait loop.
   - `done exit=0` → success.
   - `done exit=<non-zero>` → failure; analyze the log.
   - `running` but the job should have finished long ago → likely crashed (the
     process died without writing the exit marker). Analyze the log with
     `bggrep` (any jobs dir, last 2 MB) or a whole-file read of the absolute
     path (needed for logs bigger than 2 MB) — with a sandboxed whole-log reader
     if your environment provides one (context-mode's `ctx_execute_file`), or
     your own file/shell tooling otherwise.

### Reading results without flooding context

If the wake message carries a `digest (<label>):` block (the label is the
entry's `label`, its type, a matched `match.name`, or the preset id /
`command`), read that
first — it is a short pass/fail scorecard configured for this project and
usually answers "what failed" without any follow-up read. `bgtail` stays the
positional-peek tool for everything else.

- **Quick peek (≤40 lines):** call `bgtail` with the job id and `lines: 40` — strips the `__BGRUN_EXIT__` marker. The first read returns the last-40 tail; repeat reads return only lines appended since your last read (delta tailing) — polling a running job is nearly free.
- **Failure extraction:** `bggrep(<job-id>, "pattern")` — line-numbered matches with optional context lines, capped and condensed. Resolves the job id to the configured jobs dir itself — no path to reconstruct. (A sandboxed whole-log reader, context-mode's `ctx_execute_file`, can read the same file given its absolute path — see below.) Searches the last 2 MiB by default; `bytes: 67112960` (the 64 MiB ceiling plus the wrapper's 4 KiB of notices and exit marker) widens it to the whole kept log — the exact ceiling alone stops a few bytes short of the marker, dropping the head you asked for — more scanning costs latency and memory, **not context**, since the returned matches stay capped. Pass your own pattern whenever you know the tool's output format; the default only catches common failure signatures.
- **Whole-log failure analysis:** read the log's **absolute path** directly
  (with a sandboxed whole-log reader if your environment has one — context-mode's
  `ctx_execute_file` — otherwise your own file/shell tooling). Unlike
  `bgtail`/`bggrep` (bounded to the last 2 MB), this covers the whole file — the
  only way to see a log bigger than 2 MB, e.g. one that hit the size ceiling.
  Copy the `log:` path from `bgrun`'s `started:` line and expand `~` yourself (it
  is not expanded for you; an absolute path or one relative to the project root).
  Otherwise it is an ordinary read: your normal Read-deny rules still apply.

  ```javascript
  ctx_execute_file(
    path: "/Users/me/project/.pi-bgrun/jobs/<JOB>.log",
    language: "javascript",
    code: "const L=FILE_CONTENT.split('\\n'); \
           const fails=L.filter(l=>/(--- FAIL|FAIL|panic:|Error:)/.test(l)); \
           console.log(`lines: ${L.length}, failures: ${fails.length}`); \
           console.log(fails.slice(0,40).join('\\n'));"
  })
  ```

  A 10 000-line `make test` log collapses to a ~30-line summary in context.

**Why `bggrep` instead of `bash grep` on the log?**

- `bash grep` output is uncapped — a retry-storm log can dump thousands of
  matching lines (megabytes) straight into context, and staying safe depends
  on remembering `| head` on every single call. `bggrep` is bounded by design
  (last 2 MB of the log, per-line 10 000-char pre-truncation, ~50 matches,
  ~8KB, plus a wall-clock match budget so a runaway regex errors instead of
  hanging).
- It takes the job id — no log-path reconstruction, no shell-quoting of the
  regex, and no reliance on the agent getting `~` expansion right.
- Output is self-describing: match count, line numbers, `…[N skipped]…` gap
  markers, `— none` for no-match.

Plain `grep` via bash is fine only for a one-off search you know is tiny.

**Never `cat`, `Read`, `bash cat`, or `bash grep` a full bgrun log.** Always
`bgtail`, `bggrep`, or (for project-local logs) a whole-file read of the path.

**Order of preference, cheapest first: `bgtail` → `bggrep` → a whole-log read.**
Reach for the whole-log read only when you need something a regex over lines
cannot express — totals, dedup, grouping, joining the log against another file.
A sandboxed reader (context-mode's `ctx_execute_file`) is the cheapest way to do
it where one exists, because the file's bytes never enter context — see below.

A sandboxed whole-log reader is not itself a context dump: the file's bytes
never enter context, only your script's **stdout** does ("raw content never
leaves"). For `ctx_execute_file` specifically: the
cost is exactly what you print — which makes `console.log(FILE_CONTENT)` (or
`print(open(path).read())`, or a big unbounded slice) the one way a whole-log
analysis turns into a context dump, and a capped-by-default 64 MiB log makes
that expensive rather than merely rude. Aggregate, then cap what you print:

- print counts / grouped summaries / the first N matches — not the content;
- keep a `.slice(0, 40)` / `[:40]` on anything you echo;
- for many different questions about one big log, index it once (`ctx_index`)
  and `ctx_search` it, instead of re-scanning the file per call;
- `bgtail` with a larger `lines`, or a tighter `bggrep` pattern, is usually the
  cheaper answer to "I need to see more".

## After an agent restart or session switch

- The live wake does not survive an agent restart or a `/resume` to a different session
  (the extension loses the child process handle). The log still completes on disk.
- After a restart/switch, run `bgstatus(<job-id>)` — the id still resolves via the
  log's `__BGRUN_EXIT__=N` marker. To browse everything on disk, use
  `bgstatus(includeDone: true)`.
- Each session only tracks its own jobs by default. Running jobs from other
  sessions appear only when `adoptForeignJobs` is enabled in
  `$AGENT_DIR/pi-bgrun.json` (or `PI_BGRUN_FOREIGN_JOBS=1`); finished foreign
  logs appear with `bgstatus(includeDone: true)` regardless.

## Rules

- Call the tools; never hand-roll `nohup … &` inline.
- One job = one id. Multiple concurrent jobs are fine — each has its own log.
- Job logs are capped by default (`maxLogBytes` / `PI_BGRUN_MAX_LOG_BYTES`,
  64 MiB; `0` = unlimited) and the cap keeps the **first** bytes. A log that
  ends with `__BGRUN_TRUNC__ output truncated: kept the first <N> bytes` (or
  `__BGRUN_NOCAP__ log ceiling unavailable`, when the ceiling could not be
  installed and the job ran uncapped) hit that ceiling: output past it was dropped, not lost to a failure — the job
  still ran to completion with its real exit code, and readers (`bgtail`,
  `bggrep`, the wake's line count/last line) filter the notice out. The wake's
  Stats line, `bgtail` and `bggrep` all say when a log was capped (and report
  `truncatedAtBytes` in their details), and a configured digest scorecard is
  skipped rather than scored against an incomplete log — so on a capped job,
  read a missing digest as "unknown", **not** as "no failures", and do not
  re-run the command to see the missing tail; raise the ceiling if you need the
  whole log. The flag lives in the exit marker (`__BGRUN_EXIT__=0
  truncated=<N>`, or `nocap=1`), never in printable text — the `__BGRUN_*__`
  lines are reserved, so a notice-looking line printed by the command itself is
  content, not a signal. A search window is also limited to its last
  500 000 lines: when that bites, `bgtail`/`bggrep` say so — a "none" from a
  trimmed window means the head was not searched.
- Logs default to `<project>/.pi-bgrun/jobs` in a repo — project-scoped is the
  model (`~/.pi-bgrun/jobs` is a deprecated fallback for a cwd with no project
  root; an absolute `PI_BGRUN_DIR`/`jobsDir` still works but is legacy). Project-local dirs are
  auto-ignored via `.git/info/exclude`, which keeps `git status` clean; the
  logs stay reachable for project-sandboxed analysis tooling (context-mode's
  `ctx_execute_file`, where installed) because they live inside the project.
- Cleanup: `bgclean` removes only THIS session's old logs; `bgclean all`
  sweeps every session's. Auto-sweeps at session start/shutdown are
  session-scoped plus an orphan pass (default on — removes finished week-old
  logs from crashed/abandoned sessions; disable with `globalAutoClean: false`
  / `PI_BGRUN_GLOBAL_AUTO_CLEAN=0`). Under the project-local default the orphan
  pass covers the current project's jobs dir AND the machine-global
  `~/.pi-bgrun/jobs`; an explicit absolute `jobsDir` is swept alone. Retention
  is `cleanupDays` (default 7, configurable).
- To stop a running job, call `bgkill` with its id: `SIGTERM` to the job's **process group** (required because the child is spawned detached), or `force: true` for `SIGKILL` when it ignores that. It refuses an id that already finished, one that is not a bgrun job, another session's job unless you pass `includeForeign: true` (the same session-scoped default `bgclean` uses), and a pid that cannot be the job's — gone, unusable, or recycled onto an unrelated process, which it reports instead of signalling a stranger. It tells you what it *sent*, never a guess at the outcome: the authoritative result still arrives as the wake (a foreign job's is picked up by the stale-check). By hand: `bash` with `kill -- -<pid>`; the pid is the last `--`-separated segment of the job id.
