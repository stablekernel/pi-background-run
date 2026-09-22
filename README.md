# pi-background-run

Run long shell commands (test suites, builds, linters) as detached background jobs
so your agent session stays unblocked and its context stays clean. Output lands
on disk — the full log plus a trailing exit marker — so nothing large ever enters
the conversation; the command returns immediately. When the job finishes,
pi-background-run **wakes the live agent session** so it proactively reads a
condensed digest of the results and continues — no polling, no human intervention.

Built as an extension for both [pi](https://github.com/earendil-works/pi-coding-agent)
and [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`). No
shell runner and no external daemon — the extension spawns the job in-process,
detects completion via the child `exit` event, and calls `pi.sendUserMessage` to wake
the agent. The log file is self-describing (full output + a trailing
`__BGRUN_EXIT__=N` marker), so exit codes survive the agent restarting. Two small
pieces exist beyond the spawn: a 30s timer that only re-checks jobs whose live child
handle is gone (reconstructed from a restart, or adopted from another session), and a
`.last-clean` marker that throttles the **global** orphan sweep (the
session-scoped sweep is unthrottled).

## Install

```bash
pi install npm:pi-background-run        # pi
omp plugin install npm:pi-background-run  # oh-my-pi
```

The scoped alias `@stablekernel/pi-background-run` is the same package (permanent
namespace claim, published in lockstep). Prefer the unscoped name; the alias is
not deprecated, so both stay installable and receive every release.

Restart the agent after install so the extension loads.

### Host differences

One extension serves both hosts. Paths in this README are written against two
host-supplied names:

| Name | pi | oh-my-pi |
| --- | --- | --- |
| `$AGENT_DIR` — the user-level agent directory | `~/.pi/agent` | `~/.omp/agent` (profile-aware) |
| `$CONFIG_DIR` — the project config directory | `.pi` | `.omp` |

The host also decides several details, all handled internally:

- **Tool visibility.** `omp` mounts any tool that does not opt out as an
  `xd://` device (`write xd://bgrun {…}`); bgrun declares `loadMode: "essential"`
  so all five tools stay directly callable, exactly as on pi.
- **Tool guidance.** pi reads the tool definition's `promptSnippet` /
  `promptGuidelines` into the system prompt; omp reads only `description`, so on
  omp the same bullets are folded into the description instead of being dropped.
- **Job cards.** pi renders an `bgrun-job` card per job in the transcript. omp has
  no entry renderer (`pi.appendEntry` records are never rendered — it renders only
  `pi.sendMessage` entries), so on omp the job card is skipped. The entries are
  still persisted on both hosts, and the index is rebuilt from them on
  `session_start` and on omp's `session_switch` / `session_branch` (which is how
  omp announces `/new`, `/resume`, a fork and a tree branch).
  The card's job — "what is running, and how did the last one end" — is covered on
  both hosts by the editor panel and the status line (see
  [What the human sees](#what-the-human-sees)) at no context cost and without an
  entry renderer; the transcript still anchors each job through the `bgrun` tool
  card and the wake message, and `bgstatus` has the full history on demand.
- **Host-managed background jobs.** omp backgrounds long `bash` calls itself and
  exposes its in-process job list to extensions (`getAsyncJobSnapshot`), so bgrun
  reports those jobs alongside its own — in the panel, the status line and
  `bgstatus` (see [What the human sees](#what-the-human-sees)) — and reads back
  the artifact the host spills a truncated job's full output to. pi has no job
  manager, no snapshot API and no session artifacts, so every one of those paths
  degrades to bgrun-only. Nothing here is ever adopted, cancelled or cleaned by
  bgrun: those jobs are the host's, and `hub` is how the agent steers them.
- **Diagnostics.** Warnings and errors go to `pi.logger` when the host has one
  (omp writes `~/.omp/logs/omp.<date>.<pid>.log`; the TUI owns the terminal, so
  a raw stderr write would corrupt it) and to the console on pi. Anything the
  *agent* may need to act on is not left there: the digest type-mismatch note
  rides the wake instead (see [Multiple scorecards](#multiple-scorecards-one-per-job-type)).

## Tools registered

| Tool | Purpose |
| ------ | --------- |
| `bgrun` | Launch a command detached in the background. Optional `name` gives the job a short human-readable label. Returns `started: <job-id>` immediately. Wakes the session automatically on completion. |
| `bgstatus` | Show job status. With an id: any job's state + exit code — a `bg_N` id (the host's own background job on omp) is answered with its state, where its output went and how to cancel it, rather than "not found". Without: this session's running jobs (finished jobs hidden by default — pass `includeDone: true` or set `showCompletedJobs`), then the host's background jobs under their own heading. Other sessions' *running* jobs are listed only when `adoptForeignJobs` is enabled; finished foreign logs from the shared dir can also appear when finished jobs are included. |
| `bgtail` | Read the newest lines of a job's log (default 40; it reads the log's **last 2 MB** — widen with `bytes`, max 64 MiB + 4 KiB of wrapper overhead), **condensed for context**: ANSI escapes stripped, repeated lines collapsed (a run of 3+ folds into one line carrying its `[xN]` count; a pair is kept as two lines — a fold needs its count to stay legible), long lines and total size capped. First read = full last-N tail; repeat reads return **only lines appended since your last read** (delta tailing) — polling a running job never re-pays for lines already seen. Pass `raw: true` for the unprocessed last-N window (still advances the bookmark). On omp, a native `bg_N` job's spilled output is read the same way, stamped as the host's file. |
| `bggrep` | Regex search over the **last 2 MB** of a job's log (`bytes` widens the window, max 64 MiB + 4 KiB of wrapper overhead; on omp, a native `bg_N` job's spilled output is searchable the same way): line-numbered matches, optional `context` lines, each line pre-truncated to 10 000 chars before matching, results capped (~50 matches, ~8KB) and condensed. Resolves the job id to the configured jobs dir itself — no log path to reconstruct. `ctx_execute_file` can read the same file (it takes an absolute path; only your Read-deny rules apply), but it needs that path. Matching runs under a wall-clock budget ([Bounded matching](#bounded-matching)). With no `pattern`, a generic failure-signature default is used (override it — convenience, not guarantee). |
| `bgclean` | Remove old job logs. **Default scope: this session's jobs only** — other sessions' logs are untouched — and it also drops stale per-project digest markers (`.bgrun-used-*`, `.digest-nudge-*`) in the session's jobs dir (markers are not session data). Pass `all: true` to sweep every shared jobs dir — under the project-local default that is the project's dir plus the machine-global one, while an explicit absolute `jobsDir` is swept alone — and do the same marker sweep across them. Retention: `cleanupDays` config (7 days); `days` must be a positive number (`days: 0` is rejected rather than purging everything). Never removes a running job's log. |

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

- Deprecated: the machine-global jobs dir (`PI_BGRUN_GLOBAL_DIR`, `~/.pi-bgrun/jobs`) — see [deprecation](#deprecated-machine-global-jobs-dir). Supported until a future major.
- `bgkill` — not implemented; to stop a running job, use `kill -- -<pid>` (kill the process group — the child is spawned detached). The pid is the last `--`-separated segment of the job id (e.g. `unit-tests-1726680000-12345` → pid `12345`); it is not shown as a separate field in `bgstatus` output.
- `bgwait` — not implemented; the wake mechanism makes blocking on a job unnecessary in the normal flow.
- **A job started inside a subagent** (`task`/`eval` child) wakes *that* child, not
  the parent. Its completion wake is addressed to the session that spawned it, so
  a long job outliving the child's run wakes nobody. The **log is not lost**: it
  lands in the shared jobs dir, so `bgstatus <id>` / `bgtail <id>` read it from
  any session in the project. Start long jobs from the main session (`bgrun` is
  available to subagents on both hosts; this is about where the wake lands).
  oh-my-pi's own async machinery would fix it, but it is not reachable from an
  extension: `ctx` exposes only a read-only `getAsyncJobSnapshot()`, the
  registering `AsyncJobManager` lives on the internal `ToolSession`, and the
  built-in `bash` background mode that does register is not delegatable
  (`ctx.invokeTool` is same-name only).

## How it works

```text
agent calls bgrun(command: "make test-short", name: "unit-tests")
  → extension resolves log path: <jobsDir>/<slug>-<ts>-<pid>.log (default <project>/.pi-bgrun/jobs/ in a repo, else ~/.pi-bgrun/jobs/)
  → spawn('sh', ['-c', <wrapper>, 'bgrun', '<cmd>'],
          { stdio: ['ignore', logFd, logFd], detached: true }).unref()
       <wrapper> = the output-ceiling pipeline (see "Log size ceiling"), or the
       uncapped one-liner 'sh -c "$1"; ec=$?; printf "\\n__BGRUN_EXIT__=%d\\n" "$ec"; exit "$ec"'
       when the ceiling is disabled (maxLogBytes: 0)
  → records job in-memory + appends a bgrun-job entry to the session
  → returns "started: <job-id>"

child 'exit' event fires:
  → extension records exit code, appends a done entry
  → pi.sendUserMessage(wake) when idle (triggers a turn)
     or pi.sendUserMessage(wake, { deliverAs: 'followUp' }) when busy
  → ctx.ui.notify(...)  — toast for the human
  → ctx.ui.setWidget("bgrun", ...)  — live panel: the running jobs
  → ctx.ui.setStatus("bgrun", ...) — one-line outcome that outlives the panel
```

The child writes the log directly via its own stdout fd (no pipe to the agent), so the job
survives the agent crashing and the log completes on disk. The trailing
`__BGRUN_EXIT__=N` marker makes the log self-describing — `bgstatus` recovers the
exit code even after a restart.

### What the human sees

Both hosts get the same two surfaces, so a job's progress and outcome are
visible without the conversation having to carry them:

- **Editor panel** (only while something is running — it never takes editor
  space when idle): a header with the running count, then a row per running job
  (full id, label, elapsed). Deliberately nothing else — a list of finished jobs
  above the editor competes with the work in progress, and `bgstatus` answers
  "what ran" on demand. Rows are bounded to the 10 lines both hosts cap a widget
  at, with `… N more running` instead of a silently dropped tail.
- **Status line** (always visible): `⏳ N running` while jobs are in flight,
  then `✅ <name> exit=0` for the most recent finish, cleared when the session
  has neither.

Both surfaces also cover the **host's own** background jobs — oh-my-pi
backgrounds long `bash` calls itself (`bash.autoBackground`, or `async: true`)
and delivers their output as an async result. Those are not bgrun jobs: their ids
look like `bg_1`, they have no log here, and they are cancelled when the session
is switched or replaced. The panel tags them `native` and `bgstatus` lists them
under their own heading, so one glance (or one call) covers all background work
in the session, and an id from either namespace explains itself — `bggrep bg_5`
names what `bg_5` is, where its output went, and how to kill it (`hub cancel
ids:["bg_5"]`, the host's own tool), instead of a bare "no log found".

When the host truncated a native job's output it spills the full text to a
session artifact, and the delivery advertises the id. bgrun resolves it, so
`bgtail bg_5` / `bggrep bg_5` read the host's own spill through the same bounded
readers used for bgrun logs — the same condensation, caps and grep budgets, with
the output stamped as the host's file (no exit marker, not ours to clean). That
mapping is deliberately in-memory: `bg_N` ids restart at 1 and artifact ids are
session-scoped, so a persisted one could point at a different job's output after
a restart. A native job whose output was small enough to deliver inline has no
artifact, and bgrun says so rather than inventing a path.

The panel and status line are also re-indexed when oh-my-pi changes the
transcript: `/new`, `/resume`, a fork and a tree branch emit
`session_switch`/`session_branch` instead of `session_start`, so listening only
for `session_start` left a fresh session reporting the jobs of the one before it.
Finished jobs are dropped with the transcript that ran them; jobs that are still
running stay, since they outlive it.

On pi a `bgrun-job` card is also drawn in the transcript (an entry renderer),
which omp cannot render — hence these two surfaces. Neither is a history view:
the panel is live-only and the status line keeps just the latest outcome (plus
`N result pending` when the host has settled a job but not yet injected its
result); use `bgstatus includeDone: true` when you need the full list. See
[Host differences](#host-differences).

## Reading results without flooding context

Two-tier read model — the log file itself stays on disk, capped (see
[log size ceiling](#log-size-ceiling)), for deep analysis; only bounded digests
ever enter the conversation:

- **Quick peek:** `bgtail <id>` — condensed newest lines (ANSI stripped, repeats
  collapsed only where the count can be shown, ~2KB/line and ~8KB caps). The first read is the last-40-lines tail; each later
  read returns only what was appended since, so repeated polling is nearly
  free. The wake message itself already carries the exit code and the log's
  last line, so many turns need no follow-up read at all.
- **Pattern search:** `bggrep <id> [pattern] [context]` — line-numbered matches,
  capped and condensed (~50 matches, ~2KB/line, ~8KB); takes the job id, so
  there is no log path to reconstruct. Searches the **last 2 MB** by default —
  pass `bytes` to widen (max 64 MiB), or use `ctx_execute_file` on the path for
  whole-file code-based analysis. Pass your own pattern when you know the log's
  format. A **wider window costs latency and memory, not context**: the returned
  matches stay capped either way.
- **Whole-log analysis:** `ctx_execute_file` on the job's log path (reachable
  when logs are project-local) to extract only failure lines. Never `cat` or
  `Read` a full bgrun log. The sandbox keeps the file's bytes out of context —
  only your script's **stdout** enters it — so print aggregates and capped
  slices (`fails.slice(0, 40)`), never the content. With a 64 MiB-ceiling log,
  an unsliced `console.log(FILE_CONTENT)` is the one way this path becomes the
  dump it exists to avoid; use `bgtail`/`bggrep` first, and this third.

**Why `bggrep` instead of `bash grep` on the log?** A bash grep's output is
uncapped — a retry-storm log can dump thousands of matching lines straight
into context, and safety depends on remembering `| head` on every call.
`bggrep` is bounded by design (last 2 MB of the log by default — `bytes` widens
it, max 64 MiB — per-line 10 000-char pre-truncation before matching, ~50
matches, ~8KB), takes the job id instead of
a reconstructed log path (no shell-quoting of the regex), resolves the job id to the
configured jobs dir itself (no path to reconstruct), and reports match counts,
line numbers, and skip markers. Plain `grep` is fine only for a one-off search you know is tiny.

### Bounded matching

`bggrep` takes a **caller-supplied regex**, and a pathological one (for example
`(a+)+$`) can backtrack exponentially. V8 has no regex step limit and cannot
interrupt a regex running on the main thread, so the match loop runs in a
worker with a wall-clock budget (default `2000ms`, override with
`PI_BGRUN_GREP_TIMEOUT_MS`). If the budget is exceeded the worker is terminated
and `bggrep` returns an error — **a runaway pattern fails, it never hangs the
session.** Normal patterns and logs finish far inside the budget; worker
startup adds a few tens of milliseconds per call.

### Log size ceiling

stdout+stderr used to go straight to the log file with no write bound, so a
runaway job (`yes`, a spew loop, a pathological build) could fill the disk and
take the machine down. Job logs are now capped (`maxLogBytes` / `PI_BGRUN_MAX_LOG_BYTES`,
default **64 MiB**, `0` = unlimited):

- The cap keeps the **first** N bytes. There is no portable in-tree way to keep
  the tail — a ring buffer needs a helper binary, and rewriting the file breaks
  the readers that depend on the exit marker staying last. A job past 64 MiB is
  almost always a runaway, so the head is the useful part.
- The ceiling lives **inside the detached process tree**, so it still holds
  after the agent exits or crashes — it is not an agent-side watchdog.
- The job is **not** killed, and its real exit code is preserved: bytes past the
  cap are drained and discarded instead of SIGPIPE'ing the producer into `141`.
- It is **not silent**. The log carries
  `__BGRUN_TRUNC__ output truncated: kept the first <N> bytes` on the line
  before the exit marker, and the marker line itself carries the flag
  (`__BGRUN_EXIT__=0 truncated=67108864`). Both are reserved `__BGRUN_*__` lines
  that content readers filter exactly like the exit marker, and readers classify
  the notice by that **marker flag**, never by matching text — a command that
  echoes a notice-shaped line cannot make its own log look capped, and cannot
  get its own output discounted as wrapper bookkeeping either. If the ceiling
  could not be installed at all (`mkfifo` unavailable, so the job ran uncapped)
  the log says that too — `__BGRUN_NOCAP__ log ceiling unavailable`, with
  `nocap=1` in the marker — so "uncapped" is never indistinguishable from
  "output was that small". Every surface the agent reads is labelled: the wake's
  Stats line gains `log truncated at 64 MiB`,
  `bgtail` and `bggrep` append a note and report `truncatedAtBytes` in their
  details, and a configured digest scorecard is **skipped** rather than run
  against a log that lost its end — summaries and failure lists live at the end,
  so its numbers would be confidently wrong. Treat a skipped digest on a capped
  job as "unknown", not "no failures".
- Reading a capped log stays readable-whole: the widest `bytes` window is the
  ceiling **plus 4 KiB** (not the ceiling itself, which a capped log always
  exceeds by its notices and marker), so `bytes: 67112960` (ceiling + the wrapper's
  4 KiB) is what spans the whole
  kept log. Windows are additionally limited to their last 500 000 lines —
  materializing a 64 MiB window of one-character lines would cost gigabytes of
  strings — and when that line bound trims a window, `bgtail`/`bggrep` say so in
  the same labelled way instead of silently answering from a subset.
- Maintainer rationale — why a fifo, why the *first* bytes, which alternatives
  were measured and rejected: [`docs/log-size-ceiling.md`](docs/log-size-ceiling.md).
- Cost: a capped job runs through one copier process (`perl` where available,
  else `dd`/`head`) reading the job through a fifo, plus a bounded drain wait —
  a few tens of milliseconds of job startup, no steady-state overhead. The
  copier is also what drains the stream past the cap, so the producer is never
  SIGPIPE'd.
- Configure `maxLogBytes: 0` for the previous uncapped behavior, e.g. when the
  whole log must survive for `ctx_execute_file`.

## Configuration

The jobs dir defaults to `<project>/.pi-bgrun/jobs` when the session cwd is
inside a recognizable project root (`.git` or `$CONFIG_DIR`, found by walking up from
the cwd); otherwise it falls back to `~/.pi-bgrun/jobs`. **Warning:** a
`jobsDir` (or a `PI_BGRUN_GLOBAL_DIR` target) equal to your home directory is
dangerous — cleanup removes matching `*.log` files directly there. The home
directory itself is never treated as a project root — the host's global agent
dir (`$AGENT_DIR`) would otherwise make every cwd under `$HOME` resolve to `$HOME` (a symlinked
is still recognized). Override via `jobsDir` / `PI_BGRUN_DIR`. Within a project,
the dir is shared by every agent session working in that checkout — that sharing
enables cross-session job lookup, session-restart reconstruction, and
per-project cleanup. By default each session only *tracks its own jobs*: the
panel and `bgstatus` listings show this session's running jobs, and `bgstatus`
keeps finished jobs out of its listing unless asked (`bgstatus includeDone:
true`) — the panel never shows finished work at all. The status line holds the
latest outcome. Jobs started by other sessions can still be inspected by id, but
they don't clutter your panel.

Configuration is layered (later wins): **defaults ← user config file ← project
config file (trusted projects only) ← environment variables**.

- User: `$AGENT_DIR/pi-bgrun.json`
- Project: `<project>/$CONFIG_DIR/pi-bgrun.json`

The project file is per-contributor state, not shared policy: it is read only for
a trusted project, it changes what every `bgrun` job in that checkout does, and a
digest entry runs a shell command at wake time. This repo therefore gitignores
its own; [`docs/dogfooding.md`](docs/dogfooding.md) has the setup its maintainers
run locally (completed jobs visible, a scorecard on `bun test` runs).

```json
{
  "adoptForeignJobs": false,
  "showCompletedJobs": false,
  "cleanupDays": 7,
  "maxLogBytes": 67108864,
  "globalAutoClean": true,
  "jobsDir": "/some/other/dir"
}
```

### Project-local logs (default in repos)

Inside a recognizable project root, job logs land at `<project>/.pi-bgrun/jobs`
by default. The root is found by walking up from the session cwd, so a session
started in a subdirectory still resolves project-locally. An explicit
**relative** `jobsDir` (from any config layer, or `PI_BGRUN_DIR`) still
resolves against the project root — e.g. `"jobsDir": "var/bgrun-logs"` writes
to `<project>/var/bgrun-logs`.

Benefits:

- Logs sit inside the project sandbox, so project-confined analysis tools
  (e.g. context-mode's `ctx_execute_file` / `ctx_index`) can process whole logs
  without pulling raw bytes into the context window.
- Each checkout/worktree gets its own logs — no cross-project clutter in a
  machine-global dir.
- The dir is auto-added to the repo's `.git/info/exclude` (local-only — the
  tracked `.gitignore` is never touched), so logs never pollute `git status`.
  This happens on the first `bgrun`; at session start it also happens for
  **trusted** projects only, so merely opening the agent in an untrusted repo neither
  edits `.git/info/exclude` nor creates the dir. Works in linked worktrees too
  (writes to the common git dir, resolved via the worktree's `commondir` file).

**Upgrading from a pre-project-local version:** in a repo the default jobs dir
is now `<project>/.pi-bgrun/jobs`, not `~/.pi-bgrun/jobs`. Keep the old
behavior with an absolute `jobsDir`/`PI_BGRUN_DIR`. Old global logs aren't
moved, but under the project-local default the orphan sweep and `bgclean all`
still reach them — both cover your project's dir **and** the machine-global
one. An explicit absolute `jobsDir` is swept alone, exactly as before. Jobs are
no longer discoverable across projects through a single shared dir — unless you
opt into a shared absolute `jobsDir`.

Rules and migration notes:

- Absolute `jobsDir` values behave exactly as in older versions: used as-is,
  never treated as project-local, and swept alone (the orphan sweep and
  `bgclean all` do not also touch `~/.pi-bgrun/jobs`). Set
  `"jobsDir": "~/.pi-bgrun/jobs"` (or any absolute path) to keep using the
  machine-global dir inside a repo.
- If the cwd has no `.git`/`$CONFIG_DIR` at or above it, the default falls back to
  `~/.pi-bgrun/jobs`; a relative override also falls back to the global dir
  rather than scattering logs across arbitrary directories.
- Tools resolve a job's log from the session's job record first, so jobs
  started before a config change stay readable after it.
- Existing logs in the old global dir are not migrated (they're ephemeral,
  `cleanupDays`-retained). They are still reclaimed automatically: the orphan
  sweep and `bgclean all` both cover `~/.pi-bgrun/jobs` in addition to the
  current project's dir.

### Deprecated: machine-global jobs dir

**Project-scoped logs are the model.** A single shared `~/.pi-bgrun/jobs` was
the old default; it is now **deprecated** and is no longer what any of the docs
lead with. Retirement is staged — nothing breaks today:

- `PI_BGRUN_GLOBAL_DIR` and the `~/.pi-bgrun/jobs` **default are deprecated**;
  they will be removed in a future major.
- **Supported for now:** an existing absolute `jobsDir` / `PI_BGRUN_DIR` keeps
  working exactly as before, and a cwd with no project root still falls back to
  `~/.pi-bgrun/jobs` (there is nowhere project-scoped to put it, and the
  alternative — scattering logs into an arbitrary cwd — is worse).

Why project-scoped won:

- **Each checkout owns its logs** — no cross-project clutter, no ambiguous
  `bgstatus` scope, and `bgclean` can't reach into another project's runs.
- **Reachable by project-sandboxed analysis** (`ctx_execute_file`,
  `ctx_index`): logs live inside the workspace, so whole-log analysis no longer
  needs a path outside it.
- **Disposable with the workspace** — delete the checkout, lose its logs.

What changes for you, if you set a global dir on purpose:

1. Drop the absolute `jobsDir` / `PI_BGRUN_DIR` from your config to get
   `<project>/.pi-bgrun/jobs`.
2. Planned sharing across projects is what you lose: jobs started in one
   checkout are no longer visible to a session in another, and
   `adoptForeignJobs` only adopts within the same jobs dir. If you need that,
   keep the absolute dir — it is supported, merely no longer the recommended
   default — and say so upstream if it is load-bearing for you.
3. Old logs in `~/.pi-bgrun/jobs` keep being swept (the orphan sweep and
   `bgclean all` cover both dirs under the project-local default). Delete the
   dir by hand once its logs are past retention.

Environment variables (same knobs, handy for one-off overrides):

| Variable | Default | Description |
| --- | --- | --- |
| `PI_BGRUN_DIR` | `<project>/.pi-bgrun/jobs` in repos; else `~/.pi-bgrun/jobs` | Override where job logs are stored. An absolute path is used as-is; a **relative** path resolves against the project root (see [project-local logs](#project-local-logs-default-in-repos)), falling back to `~/.pi-bgrun/jobs` when there is no project root. |
| `PI_BGRUN_GLOBAL_DIR` | `~/.pi-bgrun/jobs` | **Deprecated.** Overrides the machine-global jobs base — the fallback used only when the cwd has no project root (see [deprecation](#deprecated-machine-global-jobs-dir)). A leading `~` or `~/` is expanded to the home dir; `~user` is not. |
| `PI_BGRUN_FOREIGN_JOBS` | `false` | Adopt other sessions' running jobs into this session's widget and job list. Adopted jobs are polled so they leave the widget when they finish. |
| `PI_BGRUN_SHOW_COMPLETED` | `false` | Include finished jobs in `bgstatus` listings by default. |
| `PI_BGRUN_CLEANUP_DAYS` | `7` | Log retention for cleanup sweeps and the `bgclean` default. |
| `PI_BGRUN_MAX_LOG_BYTES` | `67108864` (64 MiB) | Byte ceiling for a job's log (stdout+stderr). `0` disables it (unlimited). See [Log size ceiling](#log-size-ceiling). |
| `PI_BGRUN_GLOBAL_AUTO_CLEAN` | `true` | Set `0`/`false` to disable the automatic orphan sweep (see below). |
| `PI_BGRUN_GREP_TIMEOUT_MS` | `2000` | Wall-clock budget for a `bggrep` match. A caller-supplied regex that exceeds it is aborted (its worker terminated) and reported as an error instead of hanging — see [Bounded matching](#bounded-matching). |
| `PI_BGRUN_USER_CONFIG` | `$AGENT_DIR/pi-bgrun.json` | Override the user-level config file path (see [Configuration](#configuration)). |

### Digest scorecard (opt-in)

Wake messages always lead with universal facts — exit code, duration, and the
command's own log line count (the internal exit marker is excluded). A project
can additionally opt into a **digest scorecard**: a one-line pass/fail summary
extracted from the log and appended to the wake.

#### Job identity: name, type, command

Every `bgrun` job carries three identifiers, and the digest selector reads all
three:

| Field | Required | Normalized | Drives |
| --- | --- | --- | --- |
| `command` | yes | used as-is (`sh -c`) | what runs; the `match.command` target |
| `name` | no | trimmed, blank → none, ≤80 chars | display label + job-id/log slug; the `match.name` target |
| `type` | no | trimmed, lowercased, blank → none, ≤40 chars | digest routing only; the first-class selector |

`name` names the job (and its log file); `type` never affects the id or the
widget, but is echoed in `bgstatus <id>` and `bgrun`'s `started:` line — its
main job is selecting the scorecard. Selection tries `type`
entries first (exact, case-insensitive), then falls back to `match.name` /
`match.command` globs. The config `type` is capped to the same 40 characters
as the job `type`, so an over-long type still matches.

#### Setting it up

Three ways, easiest first — pick the first one you're comfortable with:

1. **Ask your agent (recommended).** Say: *"Set up the pi-bgrun digest for
   this project."* The `digest-config` skill ships with this package and does
   the whole job: it samples your project's real job logs, tries the shipped
   presets against them, drafts a custom command if none fits, validates the
   result on both a green and a red log, and writes the config. It sees your
   actual output format, which is exactly what a good digest depends on —
   and you never have to read a log yourself. The one-shot toast some
   projects see on session start ("no digest configured") — once per project
   that has run a bgrun job — is pointing at this same skill.
2. **One-line preset if you know your stack.** Create
   `<project>/$CONFIG_DIR/pi-bgrun.json` (or merge into an existing one):

   ```json
   { "digest": { "preset": "go-test" } }
   ```

   | Preset | What it summarizes | Suggested `type` |
   | --- | --- | --- |
   | `go-test` | Go test output: package ok/FAIL counts + failing test names | `test` |
   | `jest` | Jest output: Tests/Test Suites summary + failed test names | `test` |
   | `pytest` | pytest output: final passed/failed/error summary line + FAILED test ids | `test` |
   | `junit-xml` | JUnit XML: `<failure>`/`<error>` counts + failing testcase names | `test` |

   All shipped presets are test runners, so they all suggest the conventional
   type `test`. The suggestion is documentation, not behavior: you still write
   the `type` on the entry yourself, and a preset entry with no `type` applies
   to every job as before.

3. **Custom command.** For formats the presets don't cover:

   ```json
   { "digest": { "command": "grep -E 'FAIL|ok  ' \"$1\" | head -5" } }
   ```

   The command receives the job's log path as `$1` and its stdout is appended
   to the wake. Worked example — a log containing:

   ```text
   PASS src/auth.test.ts (2.1s)
   FAIL src/api.test.ts
   Tests: 12 passed, 1 failed, 13 total
   ```

   plus the command `grep -E '^(PASS|FAIL|Tests:)' "$1" | head -5`, wakes with:

   ```text
   digest (command): FAIL src/api.test.ts
   Tests: 12 passed, 1 failed, 13 total
   ```

   Rules of thumb: quote `"$1"`, end the pipeline in `head -N` so output is
   bounded, and — this is the important one — **check the command against a
   green and a red log before committing to it**. A scorecard that says "all
   passing" on a failing log is worse than no scorecard. The `digest-config`
   skill does this validation for you; if you'd rather hand-tune a command
   yourself, you can also ask your agent to validate a specific command
   against specific job logs.

#### Multiple scorecards (one per job type)

`digest` can also be an ordered **list** of scorecards. Give each a `type` and
pass the matching `type:` when you start the job — the most reliable selector,
because it does not depend on the agent naming every job consistently:

```json
{
  "digest": [
    { "type": "test",  "preset": "go-test" },
    { "type": "build", "label": "build",
      "command": "grep -E '^error' \"$1\" | head -5" },
    { "match": { "command": "*cargo*" }, "label": "cargo", "preset": "go-test" },
    { "preset": "go-test" }
  ]
}
```

Start jobs with the matching type:

```text
bgrun(command: "go test ./...", name: "unit-tests", type: "test")
```

`type` is an optional `bgrun` parameter. The vocabulary is defined by the
`type` fields of the project's digest config in `$CONFIG_DIR/pi-bgrun.json`. You do
not have to read that file to use it: when a digest with typed entries is
configured and the job is started **without** a `type`, `bgrun`'s `started:` line
names the configured types and the one to pass — the one moment the answer is
still actionable. If a job's `type` (or name/command) selects no entry, the
**wake itself** carries a line naming the job and the configured types, with the
fix (`pass the matching type on the next bgrun call`) — the agent is the only
party who can correct it, and on oh-my-pi a log-only diagnostic would be
invisible to it. The same fact goes to the
host log. It is emitted **once per distinct mismatch** (at most 3 per
session, then suppressed), so a project that never passes the right type cannot
grow the context per job — a mismatched type is visible without being
scorecard-less *and* without becoming noise.

Selection order (exactly one entry, or none):

1. **Type entries first.** An entry declaring a `type` matches ONLY a job that
declared that same type — exact and case-insensitive (`"test"` matches
`"Test"`) — and must ALSO satisfy the entry's `match` if it has one. All type
entries are checked first, in config order, regardless of where they sit
relative to match entries. First type match wins.
2. **Match/default fallback.** If no type entry matched — including when the
job has no type — the entries *without* a `type` are scanned in config order:
`match.name` / `match.command` globs and no-`match` defaults, first match
wins. Put a no-`match` default **last** so jobs you didn't anticipate still get
a scorecard.
3. No match → no digest.

- `type` and `match` compose (AND): with both present the entry matches only a
  job of that type that also satisfies the glob. Use `match` alone for jobs
  that won't pass a `type`.
- `match.name` and `match.command` are **globs** tested against the job's
  `name` and command line. Both present → both must match. Matching is
  **case-insensitive and whole-string** — `*` matches any run, `?` exactly one
  character, everything else is literal, and `\` escapes the next character
  (`\*` is a literal star) — so `"*unit*"` matches `"unit-tests-run3"` while a
  bare `"unit-tests"` matches only exactly that.
- `label` sets the wake tag: `digest (<label>): …`. Precedence: `label` →
  (type entry) the type string → (matched glob entry) `match.name` → the
  entry's preset id (else `command`). So a bare `{ "preset": "go-test" }`
  wakes as `digest (go-test):`.
- First match wins; exactly one digest block is appended per wake.

The legacy single-object form still works unchanged — `{ "digest": { "preset":
"go-test" } }` is a one-entry list with no matchers.

Opt in per project via `<project>/$CONFIG_DIR/pi-bgrun.json` (read only for trusted
projects). If both `preset` and `command` are set within one entry, the preset
wins. An empty list (or one where every entry is invalid) counts as *not
configured*.

#### Guarantees

- **Exit code always leads.** The digest is appended after the universal
  stats, labeled `digest (<label>):` — `label` follows the precedence above
  (entry `label` → type string → `match.name` → preset id / `command`). It
  never overrides or reorders the exit code, duration, or line count.
- **Capped and timed.** Digest output is capped at ~500 chars, and buffering
  stops once that cap is reached — a command that prints unbounded output
  cannot balloon the wake. The digest command gets a 5s timeout plus a 250ms
  SIGTERM→SIGKILL grace (≈5.25s worst case), during which the wake waits.
- **Silent-fail.** A digest command that errors, times out, or prints nothing
  simply contributes nothing — it never breaks a wake.
- **No config, no behavior.** Absent or invalid config contributes nothing;
  without a `digest` section the wake is unchanged.

A configured wake reads like this:

```text
✅ Background job "tests" `abc123` finished (exit 1).
Command: go test ./...
Stats: 42.3s, 1204 lines
Last output: FAIL example.com/api/handlers
digest (go-test): 7 ok / 1 FAIL: TestResolveNotFound
Review the result now: call `bgtail` ...
```

Shell safety: the command comes from trust-gated config and runs with your
own privileges — the same trust boundary as the `jobsDir` setting.

A user-level default digest works too: set `digest` in
`$AGENT_DIR/pi-bgrun.json` (path overridable via `PI_BGRUN_USER_CONFIG`), and
any project without its own digest inherits it. The project `digest` section
overrides the user-level one **wholesale** (no per-key merge).

### Log cleanup

Cleanup follows the same principle as everything else: **one session should
not delete another session's artifacts.**

- **Session-scoped auto-sweep (default)** runs at `session_start` and
  `session_shutdown` and removes only *this session's* finished logs older
  than `cleanupDays`. Cheap and unthrottled.
- **Orphan sweep (default on; opt out with `globalAutoClean: false` /
  `PI_BGRUN_GLOBAL_AUTO_CLEAN=0`)** — also sweeps every shared jobs dir at
  session boundaries — the machine-global `~/.pi-bgrun/jobs` plus the current
  project's dir — removing *finished* logs (exit marker, or dead pid) older
  than `cleanupDays`. This is what keeps orphans from sessions that
  crashed or will never be resumed from accumulating: a week-old finished log
  is garbage under the same retention its owning session would apply itself.
  Under the project-local default it covers the current project's dir plus the
  machine-global one; an explicit absolute `jobsDir` is swept alone. Throttled
  to once per `cleanupDays` via a `.last-clean` marker so restart-heavy
  workflows don't re-sweep on every launch. Running jobs are pid-protected, so
  live sessions are never affected.
- **Manual**: `bgclean` cleans this session's old logs; `bgclean` with
  `all: true` sweeps every session's logs across the shared dirs immediately
  (and refreshes the markers).

- Running jobs are never swept while their pid is alive.

**The jobs dir is only *auto*-swept when it is recognizably ours.** `bgrun`
writes a `.bgrun-jobs` ownership marker into the dir on first use; the
automatic global sweep refuses to delete `*.log` files in a dir without it, so
a stray `PI_BGRUN_DIR` (or a config pointing at an unrelated directory) can't
be quietly emptied a week later. Manual `bgclean all` is an explicit
instruction, so it bypasses the gate and always works.

The dir also carries small bookkeeping files. The digest markers
(`.bgrun-used-*`, `.digest-nudge-*`) and stale `.tmp-*.log` staging files are
swept at `cleanupDays`; `.bgrun-jobs` and `.last-clean` persist until removed
by hand:

| File | Purpose |
| --- | --- |
| `.bgrun-jobs` | Ownership marker — gates the *automatic* global sweep. |
| `.last-clean` | Throttles the global sweep to once per `cleanupDays`. |
| `.bgrun-used-<hash>` | Per-project evidence that bgrun has run here (digest nudge). |
| `.digest-nudge-<hash>` | Per-project: the one-shot digest nudge was already shown. |

## Releasing

Version numbers and the changelog are derived from commit messages via
[release-please](https://github.com/googleapis/release-please), so the prefix on a
squash-merged PR title is load-bearing:

| Prefix | Release |
| --- | --- |
| `fix:` / `feat:` / `deps:` | yes — patch / minor / patch |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` | yes — minor (pre-1.0) |
| `refactor:` `docs:` `test:` `ci:` `build:` `chore:` `style:` | no |
| no prefix, e.g. `Address review findings (#11)` | no |

An unprefixed commit is ignored outright: no changelog entry, and it cannot trigger
a release on its own. `pr-title.yml` enforces the format on every PR
(`bun run lint:pr-title` locally).

**PRs are squash-merged, and that is structural rather than stylistic:** the squash
collapses the PR to a single commit whose subject is the *title*, which is the
message release-please parses. That is why the title — not the branch commits — is
what CI validates, and why work-in-progress commit messages never surface. Rebase
and merge-commit methods would put branch subjects on `main` and break that mapping,
so repository settings must disable both ([`docs/releasing.md`](docs/releasing.md)
lists the exact toggles).

Every merge to `main` updates a single open **Release PR** holding the `package.json`
bump and `CHANGELOG.md` entry. Nothing is published until that PR is merged —
ordinary merges only update it.

Process, the required repository settings, and the two manual steps per release:
[`docs/releasing.md`](docs/releasing.md).

## Status

Early / pre-release.
