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
| `bgtail` | Read the newest lines of a job's log (default 40), **condensed for context**: ANSI escapes stripped, repeated lines collapsed, long lines and total size capped. First read = full last-N tail; repeat reads return **only lines appended since your last read** (delta tailing) — polling a running job never re-pays for lines already seen. Pass `raw: true` for the unprocessed last-N window (still advances the bookmark). |
| `bggrep` | Regex search over a job's log: line-numbered matches, optional `context` lines, capped (~50 matches, ~2KB/line, ~8KB) and condensed. Runs inside the extension, so it reaches **any** jobs dir — including global logs that project-sandboxed tools (`ctx_execute_file`) cannot. With no `pattern`, a generic failure-signature default is used (override it — convenience, not guarantee). |
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

- **Quick peek:** `bgtail <id>` — condensed newest lines (ANSI stripped, repeats
  collapsed, ~2KB/line and ~8KB caps). The first read is the last-40-lines tail; each later
  read returns only what was appended since, so repeated polling is nearly
  free. The wake message itself already carries the exit code and the log's
  last line, so many turns need no follow-up read at all.
- **Pattern search:** `bggrep <id> [pattern] [context]` — line-numbered matches,
  capped and condensed (~50 matches, ~2KB/line, ~8KB); works on global jobs dirs that `ctx_execute_file`
  cannot reach. Pass your own pattern when you know the log's format.
- **Whole-log analysis:** `ctx_execute_file` on the job's log path (reachable
  when logs are project-local) to extract only failure lines. Never `cat` or
  `Read` a full bgrun log.

**Why `bggrep` instead of `bash grep` on the log?** A bash grep's output is
uncapped — a retry-storm log can dump thousands of matching lines straight
into context, and safety depends on remembering `| head` on every call.
`bggrep` is bounded by design (~50 matches, ~2KB/line, ~8KB), takes the job id instead of
a reconstructed log path (no shell-quoting of the regex), runs on any jobs
dir — including global logs that project-sandboxed tools like
`ctx_execute_file` cannot reach — and reports match counts, line numbers, and
skip markers. Plain `grep` is fine only for a one-off search you know is tiny.

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

### Project-local logs

A **relative** `jobsDir` (from any config layer, or `PI_BGRUN_DIR`) opts into
project-local logs: it resolves against the session's project root, so job logs
land inside the workspace — e.g. `"jobsDir": ".pi-bgrun/jobs"` in the project
config writes logs to `<project>/.pi-bgrun/jobs`.

Why you might want this:

- Logs sit inside the project sandbox, so project-confined analysis tools
  (e.g. context-mode's `ctx_execute_file` / `ctx_index`) can process whole logs
  without pulling raw bytes into the context window.
- Each checkout/worktree gets its own logs — no cross-project clutter in the
  shared dir.
- The dir is auto-added to the repo's `.git/info/exclude` (local-only — the
  tracked `.gitignore` is never touched), so logs never pollute `git status`.
  Works in linked worktrees too (`.git` file → pointed git dir).

Rules and migration notes:

- Absolute `jobsDir` values behave exactly as in older versions — nothing
  moves, nothing breaks on upgrade.
- If the session cwd is not a recognizable project root (no `.git`/`.pi`), a
  relative path falls back to the global dir rather than scattering logs
  across arbitrary directories.
- Tools resolve a job's log from the session's job record first, so jobs
  started before a config change stay readable after it.
- Existing logs in the old global dir are not migrated (they're ephemeral,
  `cleanupDays`-retained); `bgclean all` sweeps them once you've switched.

Environment variables (same knobs, handy for one-off overrides):

| Variable | Default | Description |
| --- | --- | --- |
| `PI_BGRUN_DIR` | `~/.pi-bgrun/jobs` | Override where job logs are stored. An absolute path is used as-is; a **relative** path resolves against the project root (see [project-local logs](#project-local-logs)), falling back to the default when there is no project root. |
| `PI_BGRUN_FOREIGN_JOBS` | `false` | Adopt other sessions' running jobs into this session's widget and job list. Adopted jobs are polled so they leave the widget when they finish. |
| `PI_BGRUN_SHOW_COMPLETED` | `false` | Include finished jobs in `bgstatus` listings by default. |
| `PI_BGRUN_CLEANUP_DAYS` | `7` | Log retention for cleanup sweeps and the `bgclean` default. |
| `PI_BGRUN_GLOBAL_AUTO_CLEAN` | `true` | Set `0`/`false` to disable the automatic global orphan sweep (see below). |

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
