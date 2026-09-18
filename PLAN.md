# Implementation plan: configurable digest heuristics (opt-in per project)

Worktree: `/Users/lloyd.engebretsen/orca/workspaces/pi-bgrun/digest-heuristics`
Branch: `lloydsk/digest-heuristics` (based on v0.4.0 / `2ed56b7`)

## Prerequisite check — DONE

- `origin/main` is still at `2ed56b7` (v0.4.0). The `lloydsk/reduce-context-usage`
  PR (project-local jobsDir, commits `4bf1376`/`db05479`/`328a443`/`4c95f3e`) is
  **NOT merged**.
- The non-heuristic digest (universal stats) is **also not implemented** on that
  branch — project memory lists it as "still open in same worktree".
- Decision: implement the minimal universal-stats digest on **this branch**
  (it does not depend on jobsDir — it reads the log path the job already has),
  then layer configurable heuristics on top. No duplication: this branch touches
  nothing jobsDir-related. Rebase onto main later is trivial if both land.

## Current shape (verified)

- `resolveConfig(ctx)` at `extension/index.ts:117` — layered user file ←
  trusted-project file ← env; project file only read when `ctx.isProjectTrusted()`.
  `BgrunConfigFile` (line 88) is the permissive `unknown`-typed shape.
- Wake construction at `extension/index.ts:802-836` — `child.on("exit")` builds
  `✅/❌ … (exit N)` + `Command:` + `Last output:` and sends via `sendUserMessage`.
- `condenseLogLines` (line ~880) with `ANSI_RE`, `LINE_CAP=2000`, `TOTAL_CAP=8000`.
- Tests: `node:test` with `makeFakePi` / `loadExtension` / `waitForWakes`;
  real spawns through tool `execute()`.

## Phases

### Phase 1 — Universal-stats digest (foundation, non-heuristic)

1. Track `started` → compute duration at exit (`exitedAt - started`).
2. Count total log lines at exit (single cheap read/scan of `logPath`; reuse
   streaming read; tolerate missing file).
3. Insert into wake between `Command:` and `Last output:`, e.g.
   `Stats: 42s, 1,204 lines` — universal, always present, no patterns.
4. Tests: duration and line count appear on wake; missing log doesn't break wake.
5. Commit: `feat: universal stats (duration, line count) in wake message`

### Phase 2 — Config plumbing + preset data (testable without spawning)

1. Extend `BgrunConfigFile` with `digest?: unknown`; add to `BgrunConfig` a
   resolved `digest?: { preset?: string; command?: string }`.
2. Validation: `digest.preset` must be one of the shipped preset ids;
   `digest.command` must be a non-empty string; invalid values are ignored
   silently (ground rule 3 — best-effort) — but log once via `console.error`
   for the human. If both set, `preset` wins (document this).
3. New `digestPresets.ts` (or section in `index.ts`): pure data objects —
   - `go-test`: `awk`-style pass/fail summary over the log
     (`ok`/`FAIL`/`--- FAIL:` counts + failing test names, capped).
   - `jest`: `Tests:`/`Suites:` summary lines + failed test names.
   - `pytest`: `passed`/`failed`/`error` summary line + `FAILED` names.
   - `junit-xml`: `grep -o`-style count of `<failure`/`<error` + testcase names.
   Each preset = `{ id, description, command }` where `command` is a shell
   command receiving `$1` = log path. Presets are data, trivially reviewable.
4. Export `resolveDigest(cfg)` → normalized `{ kind, command } | undefined`.
5. Tests: layering (user < project < neither), trust gating (untrusted project
   → no digest), invalid values ignored, preset/command precedence.
6. Commit: `feat: digest config section with shipped presets (go-test, jest, pytest, junit-xml)`

### Phase 3 — Wake wiring

1. In the exit handler, after building the universal part: resolve digest from
   `resolveConfig(rec.ctx)` (rec.ctx is already captured — check it exposes
   `isProjectTrusted`/cwd; if not, capture what's needed at spawn time).
2. If configured: run the preset/custom command via `spawn("sh", ["-c", cmd, "--", logPath])`
   with a **5s hard timeout** (kill on timer; `SIGKILL` after grace).
3. Collect stdout, cap to ~500 chars (first lines; use a small cap distinct
   from `condenseLogLines`' 8KB budget, but reuse `ANSI_RE` strip + per-line cap
   for consistency).
4. Append to wake as:
   `digest (project-config): <first lines, joined>`
   Nothing appended when the command errors, times out, or prints nothing
   (ground rule 3). Digest never affects exit code or ordering (ground rule 2).
5. Tests (drive real spawns through `execute()`):
   - preset digest appears on wake for a green and a red log;
   - custom command (`sed -n '1,2p'`) output appears, capped at 500 chars;
   - hanging command (`sleep 30`) → no digest, wake arrives within ~6s;
   - failing command → no digest, wake unaffected;
   - no config → wake byte-identical to today's (regression guard);
   - untrusted project → digest absent.
6. Commit: `feat: append opt-in project-config digest to wake message`

### Phase 4 — Docs + stretch

1. `README.md`: new "Digest scorecard (opt-in)" section — config example,
   preset table, shell-safety note (trust-gated config, runs with user
   privileges — same boundary as `jobsDir`), ordering guarantee
   (exit code leads, digest appended, capped, best-effort).
2. `skill/run-bg/SKILL.md`: one paragraph — when a wake carries a
   `digest (project-config)` block, read it before reaching for `bgtail`.
3. Stretch: user-level default digest in `~/.pi/agent/pi-bgrun.json` — falls
   out of the existing layering for free; document that project config
   overrides user preset/command wholesale (per-key merge on the `digest`
   object is a v0.5 question, keep it simple now).
4. Commit: `docs: digest heuristics — README + run-bg skill`

## Explicit non-goals (owned elsewhere)

- `bggrep`, delta tailing, jobsDir changes (reduce-context-usage branch).
- No pattern guessing without config — zero built-in auto-detection.

## Suggested config shape (for the README, Phase 2 review)

```json
{
  "digest": { "preset": "go-test" }
}
```

```json
{
  "digest": { "command": "grep -E 'FAIL|ok  ' \"$1\" | head -5" }
}
```

## Risk notes

- `rec.ctx` in the exit handler: verify it retains `isProjectTrusted`/cwd; if
  the captured context doesn't, pass resolved digest config into the closure at
  spawn time instead (config read at spawn = acceptable staleness window).
- Preset commands must be POSIX-sh, no project-specific paths, and must never
  read the log with unbounded output — each preset ends in `head -N`.
- 5s timeout must not delay the wake visibly when combined with `readLastLogLine`
  — everything is synchronous-ish but capped; keep total added wake latency ≤ ~5s.

## Phase 5 — Digest-config skill (ships with the package)

Decisions (settled with Lloyd):

- **No installer needed.** pi-bgrun is a pi package; skills in `skill/` are
  auto-discovered by every user with the package installed. Just add
  `skill/digest-config/SKILL.md` + an entry in `package.json` → `pi.skills`.
- **Presets stay.** They are not redundant with the skill — the skill is built
  ON them (its procedure tries each preset's command against a sampled log
  first, and only drafts a custom command when none fits). Presets are curated,
  tested, shared across users, and cover the 4 most common formats; the skill
  covers the long tail. Also explicitly in-scope in the task brief.
- **Toast keeps a single CTA.** The nudge points at the digest-config skill
  only — listing preset names in the toast adds noise without being actionable
  (the user still can't know which preset fits; that's the skill's job).
  Presets are discoverable via README + the skill itself.

Skill procedure (draft, ~7 steps — analyze project logs → validate → write config):

1. List done-job logs in the project jobsDir (`bgstatus` / directory listing).
2. Sample 2–3 logs (one green, one red) via `ctx_execute_file` — identify format.
3. Try each shipped preset's command against a sample log; clean scorecard → use it.
4. Otherwise draft a custom `digest.command` (awk/sed/grep, ends in `head -N`).
5. Validate against green AND red samples — a wrong scorecard is worse than none.
6. Write `<project>/.pi/pi-bgrun.json`.
7. Smoke-test: real `bgrun` job → check the wake's `digest (project-config)` block.

Commit: `feat: digest-config skill for per-project digest setup`

## Phase 6 — One-shot digest nudge on session_start

- `pi.on("session_start")`: nudge only when ALL of — project trusted, no
  `digest` in resolved config, ≥1 done job in the jobsDir (evidence of use).
- **Notify, not prompt**: `ctx.ui.notify` toast (zero LLM context cost). Text:
  `pi-bgrun: no digest configured for this project — use the digest-config skill to set one up.`
- **One-time, per project**: dismissal marker file in the jobsDir keyed by
  project dir (`<jobsDir>/.digest-nudge-<projectHash>`); never write to the user's
  `.pi/pi-bgrun.json` from code.
- Tests: fires with done jobs + no config; silent when digest configured,
  when untrusted, when no done jobs, and after the marker exists.
- Commit: `feat: one-shot digest-setup nudge on session_start`
