# pi-background-run

Run long shell commands (test suites, builds, linters) as detached background jobs
so your pi agent session stays unblocked and its context stays clean. Output lands
on disk — the full log plus a trailing exit marker — so nothing large ever enters
the conversation; the command returns immediately. When the job finishes,
pi-background-run **wakes the live agent session** so it proactively reads a
condensed digest of the results and continues — no polling, no human intervention.

Built as a [pi](https://github.com/earendil-works/pi-coding-agent) extension. No
shell runner, no poller, no sidecar files — the extension spawns the job in-process,
detects completion via the child `exit` event, and calls `pi.sendUserMessage` to wake
the agent. The log file is self-describing (full output + a trailing
`__BGRUN_EXIT__=N` marker), so exit codes survive pi restarting.

## Install

```bash
pi install npm:pi-background-run
```

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
| `bgtail` | Print the last N lines of a job's log (default 40), **condensed for context**: ANSI escapes stripped, repeated lines collapsed, long lines and total size capped. Pass `raw: true` to skip condensing. |
| `bgclean` | Remove old job logs. **Default scope: this session's jobs only** — other sessions' logs are untouched. Pass `all: true` to sweep the whole shared jobs dir. Retention: `cleanupDays` config (7 days). Never removes a running job's log. |

## Slash commands

Human-facing mirrors of the read/clean tools, usable directly in the TUI
without asking the agent (registered via `pi.registerCommand` — a separate
registration from the agent tools above, which is why tools alone never show
up as `/` commands):

| Command | Purpose |
| --- | --- |
| `/bgstatus [id] [done]` | One job's status by id, or the session listing (`done`/`all` includes finished jobs). |
| `/bgtail <id> [lines]` | Tail a job's log (condensed, same as the tool). |
| `/bgclean [days] [all]` | Remove old logs — session-scoped by default; `all` sweeps every session's. |

`/bgrun` is deliberately not a command — starting jobs (and reacting to their
wake messages) is the agent's workflow.

## Roadmap / not provided

- `bgkill` — not implemented; use `bash` with `kill` (job ids end in the child pid) if you ever need to stop a running job.
- `bgwait` — not implemented; the wake mechanism makes blocking on a job unnecessary in the normal flow.

## How it works

```text
agent calls bgrun(command: "make test-short", name: "unit-tests")
  → extension resolves log path: <jobsDir>/<slug>-<ts>-<pid>.log (default ~/.pi-bgrun/jobs/)
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

Two-tier read model — the log file stays complete on disk for deep analysis;
only bounded digests ever enter the conversation:

- **Quick peek:** `bgtail <id>` — condensed last-40-lines (ANSI stripped, repeats
collapsed, ~8KB cap). The wake message itself already carries the exit code
  and the log's last line, so many turns need no follow-up read at all.
- **Whole-log analysis:** `ctx_execute_file` on the job's log path to extract
  only failure lines. Never `cat` or `Read` a full bgrun log.

## Configuration

The jobs dir (default `~/.pi-bgrun/jobs`, overridable via `jobsDir` / `PI_BGRUN_DIR`)
is shared by **every pi session on the machine** — that sharing is what enables
cross-session job lookup, session-restart reconstruction, and machine-wide
cleanup. By default each session only *tracks its own jobs*: the widget and
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
  "globalAutoClean": true,
  "jobsDir": "/some/other/dir"
}
```

Environment variables (same knobs, handy for one-off overrides):

| Variable | Default | Description |
| --- | --- | --- |
| `PI_BGRUN_DIR` | `~/.pi-bgrun/jobs` | Override where job logs are stored. |
| `PI_BGRUN_FOREIGN_JOBS` | `false` | Adopt other sessions' running jobs into this session's widget and job list. Adopted jobs are polled so they leave the widget when they finish. |
| `PI_BGRUN_SHOW_COMPLETED` | `false` | Include finished jobs in `bgstatus` listings by default. |
| `PI_BGRUN_CLEANUP_DAYS` | `7` | Log retention for cleanup sweeps and the `bgclean` default. |
| `PI_BGRUN_GLOBAL_AUTO_CLEAN` | `true` | Set `0`/`false` to disable the automatic global orphan sweep (see below). |

### Digest scorecard (opt-in)

Wake messages always lead with universal facts — exit code, duration, log line
count. A project can additionally opt into a **digest scorecard**: a one-line
pass/fail summary extracted from the log and appended to the wake.

Opt in per project via `<project>/.pi/pi-bgrun.json` (read only for trusted
projects):

```json
{ "digest": { "preset": "go-test" } }
```

or with a custom shell command:

```json
{ "digest": { "command": "grep -E 'FAIL|ok  ' \"$1\" | head -5" } }
```

The command receives the job's log path as `$1`; its stdout is appended to the
wake. If both `preset` and `command` are set, the preset wins.

Shipped presets:

| Preset | What it summarizes |
| --- | --- |
| `go-test` | Go test output: package ok/FAIL counts + failing test names |
| `jest` | Jest output: Tests/Test Suites summary + failed test names |
| `pytest` | pytest output: final passed/failed/error summary line + FAILED test ids |
| `junit-xml` | JUnit XML: `<failure>`/`<error>` counts + failing testcase names |

Guarantees:

- **Exit code always leads.** The digest is appended after the universal
  stats, labeled `digest (project-config):`. It never overrides or reorders
  the exit code, duration, or line count.
- **Capped and timed.** Digest output is capped at ~500 chars; the digest
  command gets a 5s hard timeout.
- **Silent-fail.** A digest command that errors, times out, or prints nothing
  simply contributes nothing — it never breaks a wake.
- **No config, no behavior.** Absent or invalid config contributes nothing;
  without a `digest` section the wake is unchanged.

Shell safety: the command comes from trust-gated config and runs with your
own privileges — the same trust boundary as the `jobsDir` setting.

A user-level default digest works too: set `digest` in
`~/.pi/agent/pi-bgrun.json` (path overridable via `PI_BGRUN_USER_CONFIG`), and
any project without its own digest inherits it. The project `digest` section
overrides the user-level one **wholesale** (no per-key merge).

### Log cleanup

Cleanup follows the same principle as everything else: **one session should
not delete another session's artifacts.**

- **Session-scoped auto-sweep (default)** runs at `session_start` and
  `session_shutdown` and removes only *this session's* finished logs older
  than `cleanupDays`. Cheap and unthrottled.
- **Global orphan sweep (default on; opt out with `globalAutoClean: false` /
  `PI_BGRUN_GLOBAL_AUTO_CLEAN=0`)** — also sweeps the whole shared jobs dir at
  session boundaries, removing *finished* logs (exit marker, or dead pid)
  older than `cleanupDays`. This is what keeps orphans from sessions that
  crashed or will never be resumed from accumulating: a week-old finished log
  is garbage under the same retention its owning session would apply itself.
  Throttled to once per `cleanupDays` via a `.last-clean` marker so
  restart-heavy workflows don't re-sweep on every launch. Running jobs are
  pid-protected, so live sessions are never affected.
- **Manual**: `bgclean` cleans this session's old logs; `bgclean` with
  `all: true` sweeps every session's logs immediately (and refreshes the
  marker).
- Running jobs are never swept while their pid is alive.

## Status

Early / pre-release. See `.pi/wip/pi-port-plan.md` in the source tree for the design.
