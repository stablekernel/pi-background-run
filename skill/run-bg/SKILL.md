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

## When to use

- Any command expected to run > ~30s OR emit > ~100 lines.
- Typical: `make test`, `go test ./...`, `make lint`, `make build`.
- Integration / infra suites (long-running, always background).

## When NOT to use

- Commands that complete in < ~5s — the overhead isn't worth it.
- Short, quiet commands whose full output you actually need (`git status`).
- Interactive commands (prompts, REPL, SSH) — bgrun detaches from the terminal.

## Tools

| Action | Tool |
|---|---|
| Start  | `bgrun(command: "make test-short", name: "unit-tests", type: "test")` → `started: <job-id>` (name is an optional short label; use it so jobs are recognizable in `bgstatus`, the status widget, and wake messages) |
| Status | `bgstatus(<job-id>)` for one job, or `bgstatus()` for this session's running jobs — finished jobs are hidden by default; pass `includeDone: true` to list them |
| Tail   | `bgtail(<job-id>, 40)` — first read: last-40 tail; later reads: only lines appended since (delta tailing) |
| Grep   | `bggrep(<job-id>, "pattern", context?)` — line-numbered matches, capped and condensed; default pattern = generic failure signatures (override when you know the format) |
| Clean  | `bgclean()` for this session's old logs; `bgclean all` to sweep every session's (default 7-day retention) |

## Workflow

1. **Start:** call `bgrun` with the command (and a short `name`, e.g. `name: "unit-tests"`).
   When the project's digest config defines `type` entries, also pass the
   matching `type` (e.g. `type: "test"`) — like `name`, it helps the wake
   select the right digest scorecard. Note the returned job-id. Continue other
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
     `bggrep` (any jobs dir, last 2 MB) or `ctx_execute_file` on the absolute path
     (whole file — needed for logs bigger than 2 MB).

### Reading results without flooding context

If the wake message carries a `digest (<label>):` block (the label is the
entry's `label`, its type, a matched `match.name`, or the preset id /
`command`), read that
first — it is a short pass/fail scorecard configured for this project and
usually answers "what failed" without any follow-up read. `bgtail` stays the
positional-peek tool for everything else.

- **Quick peek (≤40 lines):** call `bgtail` with the job id and `lines: 40` — strips the `__BGRUN_EXIT__` marker. The first read returns the last-40 tail; repeat reads return only lines appended since your last read (delta tailing) — polling a running job is nearly free.
- **Failure extraction:** `bggrep(<job-id>, "pattern")` — line-numbered matches with optional context lines, capped and condensed. Resolves the job id to the configured jobs dir itself — no path to reconstruct. (`ctx_execute_file` can read the same file given its absolute path.) Searches the last 2 MiB by default; `bytes: 67108864` widens it to the whole capped log — more scanning costs latency and memory, **not context**, since the returned matches stay capped. Pass your own pattern whenever you know the tool's output format; the default only catches common failure signatures.
- **Whole-log failure analysis:** `ctx_execute_file` on the log's **absolute
  path**. Unlike `bgtail`/`bggrep` (bounded to the last 2 MB), this reads the
  whole file — the only way to cover a log bigger than 2 MB, e.g. one that hit
  the size ceiling. Copy the `log:` path from `bgrun`'s `started:` line and
  expand `~` yourself (it is not expanded for you; the tool takes an absolute
  path or one relative to the project root). Otherwise it is an ordinary tool
  call: your normal Read-deny rules still apply.

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
`bgtail`, `bggrep`, or (for project-local logs) `ctx_execute_file`.

**Order of preference, cheapest first: `bgtail` → `bggrep` → `ctx_execute_file`.**
Reach for the sandbox only when you need something a regex over lines cannot
express — totals, dedup, grouping, joining the log against another file.

`ctx_execute_file` is not itself a context dump: the file's bytes never enter
context, only your script's **stdout** does ("raw content never leaves"). So the
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

## After a pi restart or session switch

- The live wake does not survive a pi restart or a `/resume` to a different session
  (the extension loses the child process handle). The log still completes on disk.
- After a restart/switch, run `bgstatus(<job-id>)` — the id still resolves via the
  log's `__BGRUN_EXIT__=N` marker. To browse everything on disk, use
  `bgstatus(includeDone: true)`.
- Each session only tracks its own jobs by default. Running jobs from other
  sessions appear only when `adoptForeignJobs` is enabled in
  `~/.pi/agent/pi-bgrun.json` (or `PI_BGRUN_FOREIGN_JOBS=1`); finished foreign
  logs appear with `bgstatus(includeDone: true)` regardless.

## Rules

- Call the tools; never hand-roll `nohup … &` inline.
- One job = one id. Multiple concurrent jobs are fine — each has its own log.
- Job logs are capped by default (`maxLogBytes` / `PI_BGRUN_MAX_LOG_BYTES`,
  64 MiB; `0` = unlimited) and the cap keeps the **first** bytes. A log that
  ends with `[pi-bgrun] output truncated at <N> bytes (first <N> bytes kept)`
  hit that ceiling: output past it was dropped, not lost to a failure — the job
  still ran to completion with its real exit code, and readers (`bgtail`,
  `bggrep`, the wake's line count/last line) filter the notice out. The wake's
  Stats line, `bgtail` and `bggrep` all say when a log was capped (and report
  `truncatedAtBytes` in their details), and a configured digest scorecard is
  skipped rather than scored against an incomplete log — so on a capped job,
  read a missing digest as "unknown", **not** as "no failures", and do not
  re-run the command to see the missing tail; raise the ceiling if you need the
  whole log.
- Logs default to `<project>/.pi-bgrun/jobs` in a repo — project-scoped is the
  model (`~/.pi-bgrun/jobs` is a deprecated fallback for a cwd with no project
  root; an absolute `PI_BGRUN_DIR`/`jobsDir` still works but is legacy). Project-local dirs are
  auto-ignored via `.git/info/exclude`, which keeps `git status` clean; the
  logs stay reachable for project-sandboxed analysis tools like
  `ctx_execute_file` because they live inside the project.
- Cleanup: `bgclean` removes only THIS session's old logs; `bgclean all`
  sweeps every session's. Auto-sweeps at session start/shutdown are
  session-scoped plus an orphan pass (default on — removes finished week-old
  logs from crashed/abandoned sessions; disable with `globalAutoClean: false`
  / `PI_BGRUN_GLOBAL_AUTO_CLEAN=0`). Under the project-local default the orphan
  pass covers the current project's jobs dir AND the machine-global
  `~/.pi-bgrun/jobs`; an explicit absolute `jobsDir` is swept alone. Retention
  is `cleanupDays` (default 7, configurable).
- To stop a running job, use `bash` with `kill -- -<pid>` (process group — required because the child is spawned detached). The pid is the last `--`-separated segment of the job id; it is not shown as a separate field in `bgstatus` output. There is no `bgkill` tool.
