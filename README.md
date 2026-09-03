# pi-bgrun

Run long shell commands (test suites, builds, linters) as detached background jobs
so your pi agent session stays unblocked and its context stays clean. Output lands
in a file under `~/.pi-bgrun/jobs/`; the command returns immediately. When the job
finishes, pi-bgrun **wakes the live agent session** so it proactively reads the
results and continues — no polling, no human intervention.

Built as a [pi](https://github.com/earendil-works/pi-coding-agent) extension. No
shell runner, no poller, no sidecar files — the extension spawns the job in-process,
detects completion via the child `exit` event, and calls `pi.sendUserMessage` to wake
the agent. The log file is self-describing (full output + a trailing
`__BGRUN_EXIT__=N` marker), so exit codes survive pi restarting.

## Install

```bash
pi install npm:pi-bgrun
```

Or the scoped alias (same code, permanent namespace claim):

```bash
pi install npm:@stablekernel/pi-bgrun
```

Restart pi after install so the extension loads.

## Tools registered

| Tool | Purpose |
|------|---------|
| `bgrun` | Launch a command detached in the background. Returns `started: <job-id>` immediately. Wakes the session automatically on completion. |
| `bgstatus` | List jobs (running + done) with exit codes. Reads the in-memory table while pi is alive; scans the jobs dir after restart. |
| `bgtail` | Print the last N lines of a job's log (default 40), stripping the exit marker. |
| `bgclean` | Remove old job logs (default 7 days). Skips running jobs while pi is alive. |

`bgwait` and `bgkill` aren't registered as tools — rare in agent flows. Use `bash`
if you ever need them.

## How it works

```
agent calls bgrun(command: "make test-short")
  → extension resolves log path: ~/.pi-bgrun/jobs/<slug>-<ts>-<pid>.log
  → spawn('sh', ['-c', '<cmd>; ec=$?; printf "\\n__BGRUN_EXIT__=%d\\n" "$ec"; exit $ec'],
          { stdio: ['ignore', logFd, logFd], detached: true }).unref()
  → records job in-memory + appends a bgrun-job entry to the session
  → returns "started: <job-id>"

child 'exit' event fires:
  → extension records exit code, appends a done entry
  → pi.sendUserMessage(wakeMessage, { triggerTurn: true })  — wakes the agent
  → ctx.ui.notify(...)  — toast for the human
  → ctx.ui.setWidget("bgrun", ...)  — updates/clears the live status widget
```

The child writes the log directly via its own stdout fd (no pipe to pi), so the job
survives pi crashing and the log completes on disk. The trailing
`__BGRUN_EXIT__=N` marker makes the log self-describing — `bgstatus` recovers the
exit code even after a restart.

## Reading results without flooding context

- **Quick peek:** `bgtail <id> 40` — last 40 lines, marker stripped.
- **Whole-log analysis:** `ctx_execute_file` on `~/.pi-bgrun/jobs/<id>.log` to
  extract only failure lines. Never `cat` or `Read` a full bgrun log.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PI_BGRUN_DIR` | `~/.pi-bgrun/jobs` | Override where job logs are stored. |

## Status

Early / pre-release. See `.pi/wip/pi-port-plan.md` in the source tree for the design.
