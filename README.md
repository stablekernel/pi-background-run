# pi-background-run

Run long shell commands (test suites, builds, linters) as detached background jobs
so your pi agent session stays unblocked and its context stays clean. Output lands
in a file under `~/.pi-bgrun/jobs/`; the command returns immediately. When the job
finishes, pi-background-run **wakes the live agent session** so it proactively reads the
results and continues — no polling, no human intervention.

Built as a [pi](https://github.com/earendil-works/pi-coding-agent) extension. No
shell runner, no poller, no sidecar files — the extension spawns the job in-process,
detects completion via the child `exit` event, and calls `pi.sendUserMessage` to wake
the agent. The log file is self-describing (full output + a trailing
`__BGRUN_EXIT__=N` marker), so exit codes survive pi restarting.

## Install

```bash
pi install npm:pi-background-run
```

> The npm package is `pi-background-run` — npm blocked the name `pi-bgrun`
> (too similar to the existing `pi-bg-run`).

Or the scoped alias (same code, permanent namespace claim):

```bash
pi install npm:@stablekernel/pi-background-run
```

Restart pi after install so the extension loads.

## Tools registered

| Tool | Purpose |
| ------ | --------- |
| `bgrun` | Launch a command detached in the background. Optional `name` gives the job a short human-readable label. Returns `started: <job-id>` immediately. Wakes the session automatically on completion. |
| `bgstatus` | Show job status. With an id: any job's state + exit code. Without: this session's running jobs (finished jobs hidden by default — pass `includeDone: true` or set `showCompletedJobs`). Jobs from other sessions are only listed when `adoptForeignJobs` is enabled. |
| `bgtail` | Print the last N lines of a job's log (default 40), stripping the exit marker. |
| `bgclean` | Remove old job logs. Default retention: `cleanupDays` config (7 days). Always runs — not throttled. |

`bgwait` and `bgkill` are not provided — the pi port has no shell runner. Use
`bash` with `kill` if you ever need to stop a running job.

## How it works

```
agent calls bgrun(command: "make test-short", name: "unit-tests")
  → extension resolves log path: ~/.pi-bgrun/jobs/<slug>-<ts>-<pid>.log
  → spawn('sh', ['-c', '<cmd>; ec=$?; printf "\\n__BGRUN_EXIT__=%d\\n" "$ec"; exit $ec'],
          { stdio: ['ignore', logFd, logFd], detached: true }).unref()
  → records job in-memory + appends a bgrun-job entry to the session
  → returns "started: <job-id>"

child 'exit' event fires:
  → extension records exit code, appends a done entry
  → pi.sendUserMessage(wake) when idle (triggers a turn)
     or pi.sendUserMessage(wake, { deliverAs: 'followUp' }) when busy
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

The jobs dir (`~/.pi-bgrun/jobs`) is shared by **every pi session on the
machine**. By default each session only *tracks its own jobs*: the widget and
`bgstatus` listings show this session's running jobs, and finished jobs are
hidden (ask for them explicitly with `bgstatus includeDone: true`). Jobs
started by other sessions can still be inspected by id, but they don't clutter
your widget.

Configuration is layered (later wins): **defaults ← user config file ← project
config file (trusted projects only) ← environment variables**.

- User: `~/.pi/agent/pi-bgrun.json`
- Project: `<project>/.pi/pi-bgrun.json`

```json
{
  "adoptForeignJobs": false,
  "showCompletedJobs": false,
  "cleanupDays": 7,
  "jobsDir": "/some/other/dir"
}
```

Environment variables (same knobs, handy for one-off overrides):

| Variable | Default | Description |
| --- | --- | --- |
| `PI_BGRUN_DIR` | `~/.pi-bgrun/jobs` | Override where job logs are stored. |
| `PI_BGRUN_FOREIGN_JOBS` | `false` | Adopt other sessions' running jobs into this session's widget and job list. Adopted jobs are polled so they leave the widget when they finish. |
| `PI_BGRUN_SHOW_COMPLETED` | `false` | Include finished jobs in `bgstatus` listings by default. |
| `PI_BGRUN_CLEANUP_DAYS` | `7` | Log retention for auto-clean sweeps and the `bgclean` default. |

### Log cleanup

- **Auto-sweep** runs at `session_start` and `session_shutdown`, but at most
  **once per `cleanupDays`** (tracked by a `.last-clean` marker in the jobs dir)
  — restart-heavy workflows don't re-sweep on every launch.
- **Manual** `bgclean` always runs immediately and refreshes the marker.
- Running jobs are never swept while their pid is alive.

## Status

Early / pre-release. See `.pi/wip/pi-port-plan.md` in the source tree for the design.
