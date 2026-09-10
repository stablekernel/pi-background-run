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
| Start  | `bgrun(command: "make test-short", name: "unit-tests")` → `started: <job-id>` (name is an optional short label; use it so jobs are recognizable in `bgstatus`, the status widget, and wake messages) |
| Status | `bgstatus(<job-id>)` for one job, or `bgstatus()` for this session's running jobs — finished jobs are hidden by default; pass `includeDone: true` to list them |
| Tail   | `bgtail(<job-id>, 40)` — first read: last-40 tail; later reads: only lines appended since (delta tailing) |
| Grep   | `bggrep(<job-id>, "pattern", context?)` — line-numbered matches, capped and condensed; default pattern = generic failure signatures (override when you know the format) |
| Clean  | `bgclean()` for this session's old logs; `bgclean all` to sweep every session's (default 7-day retention) |

## Workflow

1. **Start:** call `bgrun` with the command (and a short `name`, e.g. `name: "unit-tests"`).
   Note the returned job-id. Continue other
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
     `ctx_execute_file`.

### Reading results without flooding context

- **Quick peek (≤40 lines):** call `bgtail` with the job id and `lines: 40` — strips the `__BGRUN_EXIT__` marker. The first read returns the last-40 tail; repeat reads return only lines appended since your last read (delta tailing) — polling a running job is nearly free.
- **Failure extraction:** `bggrep(<job-id>, "pattern")` — line-numbered matches with optional context lines, capped and condensed. Works on global jobs dirs that `ctx_execute_file` cannot reach (it runs inside the extension). Pass your own pattern whenever you know the tool's output format; the default only catches common failure signatures.
- **Whole-log failure analysis:** `ctx_execute_file` on the log path:

  ```javascript
  ctx_execute_file(
    path: "~/.pi-bgrun/jobs/<JOB>.log",
    language: "javascript",
    code: "const L=FILE_CONTENT.split('\\n'); \
           const fails=L.filter(l=>/(--- FAIL|FAIL|panic:|Error:)/.test(l)); \
           console.log(`lines: ${L.length}, failures: ${fails.length}`); \
           console.log(fails.slice(0,40).join('\\n'));"
  )
  ```

  A 10 000-line `make test` log collapses to a ~30-line summary in context.

**Why `bggrep` instead of `bash grep` on the log?**

- `bash grep` output is uncapped — a retry-storm log can dump thousands of
  matching lines (megabytes) straight into context, and staying safe depends
  on remembering `| head` on every single call. `bggrep` is bounded by design
  (~50 matches, ~2KB/line, ~8KB).
- It takes the job id — no log-path reconstruction, no shell-quoting of the
  regex — and works on any jobs dir, including global logs that
  project-sandboxed `ctx_execute_file` cannot reach.
- Output is self-describing: match count, line numbers, `…[N skipped]…` gap
  markers, `— none` for no-match.

Plain `grep` via bash is fine only for a one-off search you know is tiny.

**Never `cat`, `Read`, `bash cat`, or `bash grep` a full bgrun log.** Always
`bgtail`, `bggrep`, or `ctx_execute_file`.

## After a pi restart or session switch

- The live wake does not survive a pi restart or a `/resume` to a different session
  (the extension loses the child process handle). The log still completes on disk.
- After a restart/switch, run `bgstatus(<job-id>)` — the id still resolves via the
  log's `__BGRUN_EXIT__=N` marker. To browse everything on disk, use
  `bgstatus(includeDone: true)`.
- Each session only tracks its own jobs by default. Jobs from other sessions
  appear only when `adoptForeignJobs` is enabled in `~/.pi/agent/pi-bgrun.json`
  (or `PI_BGRUN_FOREIGN_JOBS=1`).

## Rules

- Call the tools; never hand-roll `nohup … &` inline.
- One job = one id. Multiple concurrent jobs are fine — each has its own log.
- Logs live in `~/.pi-bgrun/jobs` (override with `PI_BGRUN_DIR`). A **relative**
  `jobsDir` in the project config (e.g. `.pi-bgrun/jobs`) puts logs inside the
  project — auto-ignored via `.git/info/exclude` — which keeps them reachable
  for project-sandboxed analysis tools like `ctx_execute_file`.
- Cleanup: `bgclean` removes only THIS session's old logs; `bgclean all`
  sweeps every session's. Auto-sweeps at session start/shutdown are
  session-scoped plus a global orphan pass (default on — removes finished
  week-old logs from crashed/abandoned sessions; disable with
  `globalAutoClean: false` / `PI_BGRUN_GLOBAL_AUTO_CLEAN=0`). Retention is
  `cleanupDays` (default 7, configurable).
- To stop a running job, use `bash` with `kill <pid>` (the pid is in the `bgstatus`
  output). There is no `bgkill` tool.
