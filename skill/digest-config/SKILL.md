---
name: digest-config
description: Set up the pi-bgrun digest scorecard for this project. Use when the user asks to configure a digest, enable digest heuristics, or when a pi-bgrun nudge points at this skill. Samples the project's real job logs, picks a shipped preset (go-test, jest, pytest, junit-xml) or drafts a custom digest command, validates it against green AND red logs, then writes the digest section into .pi/pi-bgrun.json.
---

# Configure a project digest scorecard

Goal: a `digest` section in `<project>/.pi/pi-bgrun.json` whose command turns a
job log into a short pass/fail scorecard, appended to every `bgrun` wake as
`digest (project-config): ...`. The scorecard must be reliable on both green
and red logs — a wrong scorecard is worse than none.

Config shapes (either works; if both `preset` and `command` are set, the
preset wins):

```json
{ "digest": { "preset": "go-test" } }
```

```json
{ "digest": { "command": "grep -E 'FAIL|ok  ' \"$1\" | head -5" } }
```

Shipped presets: `go-test` (package ok/FAIL counts + failing test names),
`jest` (Tests/Test Suites summary + failed test names), `pytest` (final
passed/failed/error summary line + FAILED test ids), `junit-xml`
(`<failure>`/`<error>` counts + failing testcase names).

## Procedure

1. **Find done-job logs.** Locate the project's jobsDir: `bgstatus` shows it,
   or it comes from the config layering (project-local `jobsDir`, global
   `~/.pi-bgrun/jobs`, or `PI_BGRUN_DIR`). List the `*.log` files of finished
   jobs.
2. **Sample the format.** Pick 2-3 logs — at least one green run and one red
   run — and inspect them with `ctx_execute_file` (context-mode sandbox, so
   only your printed summary enters context). Identify the test runner /
   output format.
3. **Try a preset first.** Run each shipped preset's command against a sample
   log (`sh -c '<preset command>' sh <logpath>`). Preset commands are data in
   the package's `extension/digestPresets.ts`. Clean scorecard on green AND
   red samples → use that preset, go to step 6.
4. **Draft a custom command** if no preset fits. Use awk/sed/grep/jq; the
   command receives the log path as `$1` and MUST end in `head -N` so output
   is bounded. Keep it to a count line plus failed-item names.
5. **Validate on green AND red.** Run the draft against every sample. It must
   produce a correct scorecard on both: no phantom failures on green logs, no
   missing failures on red ones. If no command is reliable, recommend NO
   digest — leave the config unconfigured and say why.
6. **Write the config.** Merge the chosen `digest` section into
   `<project>/.pi/pi-bgrun.json`, preserving any existing keys. Create the
   file if absent.
7. **Smoke-test.** Start a real `bgrun` job (e.g. the project's test command)
   and check that its wake carries a correct `digest (project-config):`
   block. If it is empty or wrong, fix the command and repeat step 7.
