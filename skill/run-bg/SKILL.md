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
| Status | `bgstatus(<job-id>)` or `bgstatus()` for all |
| Tail   | `bgtail(<job-id>, 40)` |
| Clean  | `bgclean(7)` |

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

- **Quick peek (≤40 lines):** call `bgtail` with the job id and `lines: 40` — strips the `__BGRUN_EXIT__` marker.
- **Whole-log failure analysis:** `ctx_execute_file` on the log path:
  ```
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

**Never `cat`, `Read`, or `bash cat` a full bgrun log.** Always `bgtail` or
`ctx_execute_file`.

## After a pi restart or session switch

- The live wake does not survive a pi restart or a `/resume` to a different session
  (the extension loses the child process handle). The log still completes on disk.
- After a restart/switch, `bgstatus` scans `~/.pi-bgrun/jobs/` and recovers exit codes
  from the log's `__BGRUN_EXIT__=N` marker. If you were waiting on a job, run
  `bgstatus` to find it.

## Rules

- Call the tools; never hand-roll `nohup … &` inline.
- One job = one id. Multiple concurrent jobs are fine — each has its own log.
- Logs live in `~/.pi-bgrun/jobs` (override with `PI_BGRUN_DIR`).
- Run `bgclean` periodically; the extension also auto-sweeps old logs on startup
  (14-day threshold).
- To stop a running job, use `bash` with `kill <pid>` (the pid is in the `bgstatus`
  output). There is no `bgkill` tool.
