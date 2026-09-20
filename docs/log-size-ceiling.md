# Child stdout ceiling: design rationale

`maxLogBytes` / `PI_BGRUN_MAX_LOG_BYTES` bounds how much of a job's
stdout+stderr reaches its log file. The operator-facing contract is in the
README ([Log size ceiling](../README.md#log-size-ceiling)); this note is the
rationale a maintainer needs *before* changing the wrapper, and the record of
what was measured and rejected.

## Problem

The child's stdout+stderr go straight to the log fd
(`spawn("sh", ["-c", wrapper, "bgrun", command], { stdio: ["ignore", logFd, logFd], detached: true })`).
The read side is bounded (`LOG_TAIL_BYTES` for the exit marker, `LOG_READ_BYTES`
for `bgtail`/`bggrep`), but the **write side was unbounded**: a runaway job
(`yes`, a spew loop, a pathological build) fills the disk and can take the
machine down. A secondary effect: `countLogLines` streams the whole file at exit
(bounded memory, unbounded IO).

## Constraints

Any fix has to respect these; most of the wrapper's odd shape is one of them.

1. The cap must live **inside the detached process tree** — pi can exit at any
   time, so no parent-side streaming. A watchdog that dies with pi does not keep
   the promise.
2. The `__BGRUN_EXIT__` marker must remain the **last non-empty line**.
   Completion evidence is the *last* non-blank line only, so a marker that ends
   up mid-file is job output that happens to contain the string. A head cap
   guarantees this cheaply: the whole capped log is `cap + overhead`, well inside
   the 256 KB tail window that finds it.
3. One writer, one offset — two writers into the same file corrupt it. This
   includes the exit-code channel, which is why the exit code does **not** travel
   through the pipe (a pipeline's `$?` is the reader's).
4. Cap only the redirected stdout/stderr, **never the command's own files**.
5. `maxLogBytes: 0` means unlimited, and takes the legacy wrapper path verbatim —
   no fifo, no copier, no notices.

## The shipped shape

A fifo plus one copier process, all inside the detached tree:

```sh
# argv: $1 command, $2 ecfile, $3 fifo, $4 pidfile, $5 truncation-flag file
{ sh -c "$1" 2>&1; ec=$?; <write $ec to $2>; } >"$3" &   # producer; ec out-of-band
{ <copier: write the first CAP bytes, then drain>; \
  <if a byte remains, touch $5> } <"$3" &                # cap + flag + drain
wait "$prod"; <bounded grace for the copier>
rm -f "$2" "$3" "$4" "$5"
printf '\n__BGRUN_EXIT__%d%s\n' "$ec" "$flag"            # marker last, flag attached
exit "$ec"
```

Points that are load-bearing:

- **The copier caps, flags, and drains in one process.** `perl` first (unbuffered,
  so the live tail is not block-lagged), then `dd iflag=fullblock`, then `head`.
  Whatever variant runs, it both writes the kept bytes and consumes the rest, so
  the producer is never SIGPIPE'd and the job keeps its real exit code.
- **Completion follows the command, not the stream.** The wrapper waits on the
  producer's pid, then allows a short bounded grace (5 × 20 ms) for the copier to
  reach EOF. A child the command backgrounded and did not wait for can hold the
  fifo open indefinitely; the job must still complete — the stray's output simply
  stops being logged, which is what a ceiling is for.
- **The exit code travels out-of-band** (`$2`), so the producer group can capture
  it before the pipeline shape gets a say.
- **The flag rides the marker**, not the notice text: `__BGRUN_EXIT__=0
  truncated=67108864`, or `nocap=1` when `mkfifo` failed and the job ran uncapped.
  Readers classify by that flag; see "Visibility" below.
- **Staging paths are hardened**: they are `rm -f`'d before use, then written
  under `set -C` (noclobber) with `umask 077`, so a planted file or symlink in the
  jobs dir cannot be written through. The log itself is opened `0600`, `wx`.
- **`mkfifo` failure degrades loudly**: the job runs uncapped, the log says so
  (`__BGRUN_NOCAP__`), and the marker carries `nocap=1`. Losing output is worse
  than losing the bound, but "uncapped" must not look like "output was small".

Accepted price: the log keeps the **first** `cap` bytes, not the tail. There is
no portable in-tree *tail* cap — a ring buffer needs a helper binary, and a
circular/rewritten file breaks every existing reader (marker-at-tail, `bgtail`,
`bggrep`). A job that emits more than 64 MiB is almost always a runaway, so the
head is the useful part. Revisit only if tail retention turns out to matter in
practice.

## Why not the obvious counters

Measured on macOS 25.6 with BSD `head`, while the mechanism was being chosen:

| detection idea | result |
| --- | --- |
| bytes left after `head -c CAP` (`cat \| wc -c`) | **silently 0** whenever the overshoot is smaller than `head`'s read buffer: `CAP=100 N=101` → 0, `CAP=1000 N=1500` → 0, `CAP=8192 N=8193` → 0; only `CAP=65536 N=65537` → 1. `head` over-reads into its buffer and discards the excess. |
| `wc -c </dev/fd/1` (size the log fd) | **fails** — the log fd is opened `O_WRONLY`, so the reopen gets `Permission denied`. |
| fifo + a counting copier on the full stream | **exact** in all four cases above. |

That first row is the whole reason a fifo exists: the cheap shape reports
"no truncation" for small overshoots, which is exactly the boundary users hit
(`cap + 1` byte).

## Visibility

The log carries, before the marker:

```
__BGRUN_TRUNC__ output truncated: kept the first <CAP> bytes
__BGRUN_NOCAP__ log ceiling unavailable (mkfifo failed, so this job ran uncapped)
```

- The leading `\n` is required: without it the notice glues onto the last kept
  byte, corrupting line counts and `bggrep` line numbers.
- Both prefixes are reserved `__BGRUN_*__` lines, filtered from content readers
  exactly like the exit marker, and the *notice identity* is decided by the
  marker's flag — never by matching text. A command that echoes a notice-shaped
  line therefore cannot make its own log look capped, nor have its own output
  discounted as wrapper bookkeeping.
- `countLogLines` drops the whole trailing wrapper block (notice + marker) using
  the flag, so "N lines" counts command output only, and the wake's last-line pick
  never reports the notice as the job's last output.
- Every agent-facing surface is labelled instead: the wake's Stats line gains
  `log truncated at <N>`, `bgtail`/`bggrep` append a note and report
  `truncatedAtBytes`, and a configured digest scorecard is **skipped** rather than
  scored against a log that lost its end (summaries and failure lists live at the
  end, so the numbers would be confidently wrong).

## Reader bounds

- A capped log is always slightly **larger** than the cap — notices, marker, and
  the separator newlines. So the search-window maximum is the ceiling **plus the
  wrapper's overhead** (`readWindowMax()`), not the ceiling itself: clamping to
  the ceiling made the documented "widen it to the whole capped log" unreachable.
- A byte window is not a sufficient bound on its own: 64 MiB of one-character
  lines is ~33 M line strings, measured at >3 GB of RSS — an OOM on exactly the
  log class the ceiling exists for. A scan therefore materializes at most its last
  `LOG_SCAN_LINES_MAX` (500 000) lines (~40 MB), and says so when that bit:
  `only the last 500,000 lines of that window were searched`. A trimmed window is
  never allowed to report a plain "none".
- `countLogLines` takes its tail pread offset from `fstatSync(fd).size` and
  refuses to count (returns `null`) past the window bound, so bounding the scan
  can never misplace the marker read or drop the count for capped jobs.

## Config

- `maxLogBytes` (number, bytes) plus `PI_BGRUN_MAX_LOG_BYTES`; default **64 MiB**,
  `0` = unlimited.
- Read at spawn time, so an edit affects the next job only.
- Normalized to an integer in `1 … Number.MAX_SAFE_INTEGER` before it is ever
  interpolated into the shell: a fractional value previously truncated to `0`
  (= unlimited, silently), and a value above `MAX_SAFE_INTEGER` reached `sh` as
  `1e+21`, which the copier rejects while still consuming the stream — i.e. the
  log came out empty.

## Defects already paid for

Each of these was reproduced before it was fixed, and each has a regression test.
They are listed because they explain why the wrapper is not simpler.

| symptom | what the shape does now |
| --- | --- |
| `head -c` alone SIGPIPE'd the producer (exit `141`) | copier drains past the cap |
| `mkfifo` unavailable ran uncapped *and silently* | `__BGRUN_NOCAP__` notice + `nocap=1` |
| truncation inferable from printable text | flag in the marker; reserved notice lines |
| `sleep 30 & echo done` produced no wake for 30 s | wait on the command's pid + bounded grace |
| a ceiling of `1e21` emptied the log; `0.5` disabled the cap | integer normalization, floor of 1 |
| the widest window could not cover a capped log | window max = ceiling + overhead |
| a 64 MiB window of tiny lines cost >3 GB of RSS | 500k-line scan bound + labelled note |
| the line bound fired on logs that fit (false caveat) | only report a trim when bytes were actually dropped |
| `countLogLines` bounded its scan by the cap (dropped the count for capped jobs) | bound by the window max; `fstatSync` for the tail offset |
| stale staging files were never swept; sweeping by mtime deleted a *running* job's fifo | sweep by mtime, skipping stems whose `.pid` is a live process |

## Rejected alternatives

- **`head -c` without a drain**: producer dies on SIGPIPE (`141`) — hostile to
  legitimately verbose builds.
- **pi-side watchdog** (stat running logs, kill and truncate the tail): a soft
  bound only while pi lives; the overshoot is write-rate × poll interval, and it
  is unbounded if pi died. Keeps the tail, loses the promise.
- **`ulimit -f`**: caps *every* file the job writes (artifacts, downloads) and
  kills it (`SIGXFSZ`/`153`). Opt-in material, not a default.
- **Document-and-trim-finished-logs**: no bound at all while the job runs.
- **`dd bs=1 count=CAP` as the front stage**: exact, but one read syscall per
  byte (64 MiB = 64 M syscalls) — unusable.
- **`process.execPath` as the reader**: exact count with no coreutils/BSD
  variance, but it adds a runtime dependency to the spawn path and still needs
  the detached-tree plumbing; the fifo uses only POSIX `sh` + `mkfifo` + a
  coreutils/`dd`/`head` copier.

## Tests

The suite pins the contract, not the plumbing: exactness at the boundary
(`cap + 1` is capped, exactly `cap` is not), exit-code preservation under
megabytes of overshoot, no staging files left behind, stale staging reclaimed
while a running job's staging survives, the notice unfakeable by job output,
`nocap` visibility, config normalization (`0`, fractional, over-MAX_SAFE),
reader labelling and `truncatedAtBytes`, and the window and line bounds with
their caveats.

Run with `bun test extension/index.test.ts` (what CI runs) and, by hand,
`node --test extension/index.test.ts` — the second brings the V8/worker_threads
side of `bggrep`'s bounded matching, which Bun does not exercise.
