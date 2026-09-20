# Dogfooding bgrun in this repo

This repo's maintainers run pi-bgrun on its own test suite. The setup is a
*personal* project config, not repo policy: `<project>/.pi/pi-bgrun.json` is read
only for a trusted project, it changes what every `bgrun` job in the checkout
does, and one of its keys runs a shell command at wake time. So it is gitignored
here — copy the example below into your own working copy if you want the same.

```json
{
  "showCompletedJobs": true,
  "digest": [
    {
      "type": "test",
      "match": { "command": "*bun test*" },
      "label": "bun-test",
      "command": "grep -E '[0-9]+ (pass|fail)$' \"$1\" | tail -5"
    }
  ]
}
```

## What it does

- `showCompletedJobs: true` — finished jobs stay in the widget and in
  `bgstatus` instead of disappearing (the extension's default is `false`).
- `digest[0]` — a **scorecard**: at wake time, for a job whose `type` is `test`
  *and* whose command matches `*bun test*`, the `command` runs with `$1` set to
  the job's log path, and its stdout is appended to the wake as
  `digest (bun-test): …`. Here that prints the suite's own pass/fail lines.

`jobsDir` is intentionally absent — `<project>/.pi-bgrun/jobs` is the default in
a repo, and the extension adds it to `.git/info/exclude` so logs never show up in
`git status`.

## Try it

Start the suite as a job and let the wake carry the scorecard:

```
bgrun(command: "bun test extension/index.test.ts", type: "test", name: "unit-tests")
```

The wake then carries the suite's own numbers instead of a summary the agent
has to re-derive:

```
finished (exit 0) …
digest (bun-test):  193 pass
 0 fail
```

(the scorecard is the digest command's stdout, exactly as printed — two lines
here, because `bun test` prints one per counter).

Selection rules that make this work: entries *declaring* a `type` are considered
first and only for jobs that declared that type, and an entry's `match` must pass
as well — so `type: "test"` with a command that isn't a `bun test` run falls
through to the type-less/glob pass (and, with no entry there, gets no scorecard).

## Overriding and unwinding

Config layers are `defaults ← user ← project ← env`, so an environment variable
beats the file (`PI_BGRUN_SHOW_COMPLETED=0`, `PI_BGRUN_MAX_LOG_BYTES=0`). To drop
the setup, delete `.pi/pi-bgrun.json`; nothing else depends on it.

## See also

- README: [Digest scorecard (opt-in)](../README.md#digest-scorecard-opt-in) — the
  full selector reference, presets (`go-test`, `jest`, `pytest`, `junit-xml`), and
  the `custom`/`output` forms.
- The `digest-config` skill — samples a project's real logs, drafts a digest
  command, and validates it against green *and* red runs before writing the file.
- The per-project nudge: until a project has a digest, bgrun mentions the option
  once (a `.bgrun-used-<hash>` marker in the jobs dir records that it happened).
