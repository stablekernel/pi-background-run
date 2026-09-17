---
name: digest-config
description: Set up the pi-bgrun digest scorecard for this project. Use when the user asks to configure a digest, enable digest heuristics, or when a pi-bgrun nudge points at this skill. Samples the project's real job logs, picks a shipped preset (go-test, jest, pytest, junit-xml) or drafts a custom digest command, validates it against green AND red logs, then writes the digest section into .pi/pi-bgrun.json.
---

# Configure a project digest scorecard

Goal: a `digest` section in `<project>/.pi/pi-bgrun.json` whose command turns a
job log into a short pass/fail scorecard, appended to every `bgrun` wake as
`digest (<label>): ...`. The scorecard must be reliable on both green and red
logs — a wrong scorecard is worse than none. Most projects run more than one
kind of job (unit tests, a build, e2e); configure one entry per job type rather
than one command that guesses.

Config shapes — a single object (legacy) or an ordered **list** of entries; if
both `preset` and `command` are set within one entry, the preset wins:

```json
{ "digest": { "preset": "go-test" } }
```

```json
{ "digest": { "command": "grep -E 'FAIL|ok  ' \"$1\" | head -5" } }
```

```json
{
  "digest": [
    { "match": { "name": "unit-tests" }, "preset": "go-test" },
    { "match": { "command": "cargo build" }, "label": "build",
      "command": "grep -E '^error' \"$1\" | head -5" },
    { "preset": "go-test" }
  ]
}
```

Matching (first match wins, in config order):
- `match.name` / `match.command` are **regexes** tested against the job's
  `name` and command line; both present → both must match.
- An entry with no `match` (or an empty `match`) matches every job — put it
  **last** as the default. Include one so jobs you did not anticipate still
  get a scorecard.
- `label` sets the wake tag; without it a matched `match.name` is used, else
  `project-config`.
- An invalid regex or an entry with no valid `preset`/`command` is dropped
  silently; an empty/all-invalid list counts as unconfigured.

Shipped presets: `go-test` (package ok/FAIL counts + failing test names),
`jest` (Tests/Test Suites summary + failed test names), `pytest` (final
passed/failed/error summary line + FAILED test ids), `junit-xml`
(`<failure>`/`<error>` counts + failing testcase names).

## Procedure

1. **Find done-job logs.** Locate the project's jobsDir: `bgstatus` shows it,
   or it comes from the config layering (project-local `jobsDir`, global
   `~/.pi-bgrun/jobs`, or `PI_BGRUN_DIR`). List the `*.log` files of finished
   jobs.
2. **Sample the formats across job types.** Group the logs by job type using
   each job's `name` and command line (from `bgstatus`); most projects have at
   least a test job and a build job. Pick 2-3 logs per type — at least one
   green and one red run each — and inspect them with `ctx_execute_file`
   (context-mode sandbox, so only your printed summary enters context).
   Identify the runner / output format for each type.
3. **Try a preset first, per type.** Run each shipped preset's command against
   a sample log (`sh -c '<preset command>' sh <logpath>`). Preset commands are
   data in the package's `extension/digestPresets.ts`. Clean scorecard on green
   AND red samples → use that preset for that type. Repeat for each type.
4. **Draft custom commands** for types no preset fits. Use awk/sed/grep/jq; the
   command receives the log path as `$1` and MUST end in `head -N` so output is
   bounded. Keep it to a count line plus failed-item names.
5. **Validate each entry on green AND red.** Run every drafted command against
   every sample for its type. Each must produce a correct scorecard on both: no
   phantom failures on green logs, no missing failures on red ones. If a type
   has no reliable command, omit that entry (or leave the digest unconfigured)
   rather than shipping a wrong scorecard — say why.
6. **Write the config.** Merge the entries into
   `<project>/.pi/pi-bgrun.json`, preserving any existing keys and putting the
   no-`match` default entry **last**. Use the job's `name` for `match.name`
   where possible, a command regex otherwise. Create the file if absent.
7. **Smoke-test each entry.** Start a real `bgrun` job of each configured type
   (e.g. the test command AND the build command) and check that its wake
   carries a correct `digest (<label>):` block for the right entry. If a block
   is empty, wrong, or comes from the wrong entry, fix the command / ordering
   and repeat step 7.
