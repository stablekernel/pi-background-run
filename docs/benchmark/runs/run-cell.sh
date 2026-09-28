#!/usr/bin/env bash
# Run one benchmark cell's six sessions, one at a time, without copy-paste.
#
# NOT unattended: a bgrun cell needs a LIVE session (`H6`), so each run hands the
# terminal to `pi` and you drive it. The script does everything around that: the
# banner, the exact command, the per-run transcript check, and the profile at the end.
#
#   ./run-cell.sh red-tail-short                   # six sessions
#   ./run-cell.sh red-tail-short --dry-run         # print the six commands, launch nothing
#   ./run-cell.sh red-tail-short --variant fixed   # a re-run after a tool change
#
# A variant writes to its own session dirs (`/private/tmp/cells/<cell>-<variant>`) and its
# own profile (`.bench-runs/<cell>-<variant>/`), so a re-run can never shadow the runs it is
# being compared against — which is the same reason the refusal guard below exists.
#
# Runs are interleaved bgrun/vanilla (b1, v1, b2, v2, b3, v3): the six sessions span
# roughly half an hour, and interleaving means any drift in host load or thermals lands
# on both arms instead of on whichever arm ran last.
set -uo pipefail

cell="${1:-}"
variant=""
dry=0
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --variant) variant="${2:-}"; shift ;;
    *) echo "usage: $0 {red-tail-short|trace-root|long-buried} [--dry-run] [--variant NAME]" >&2; exit 2 ;;
  esac
  shift
done

case "$cell" in
  red-tail-short) fixture=/private/tmp/red-tail-fixture; prefix=rt ;;
  trace-root)     fixture=/private/tmp/trace-root-fixture; prefix=tr ;;
  long-buried)    fixture=/private/tmp/long-buried-fixture; prefix=lb ;;
  ""|*) echo "usage: $0 {red-tail-short|trace-root|long-buried} [--dry-run] [--variant NAME]" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
tag="$cell${variant:+-$variant}"
cells="/private/tmp/cells/$tag"
name_prefix="$prefix${variant:+-$variant}"
bifrost=/Users/lloyd.engebretsen/.pi/agent/npm/node_modules/@stablekernel/pi-bifrost/src/index.ts
suite="bun test extension/index.test.ts scripts/measure-sessions.test.ts scripts/pty-shape.test.ts"
prompt="Run $suite $fixture in this repo and report the failure details."

[ -d "$fixture" ] || { echo "error: fixture missing: $fixture" >&2; exit 2; }
[ -f "$bifrost" ] || { echo "error: bifrost extension missing: $bifrost" >&2; exit 2; }

echo "cell:    $tag"
echo "fixture: $fixture"
echo "repo:    $repo"
echo "order:   bgrun-1, vanilla-1, bgrun-2, vanilla-2, bgrun-3, vanilla-3"
echo

run_one() {
  # Declared on separate lines on purpose: macOS ships bash 3.2, which expands
  # every RHS of a multi-assignment `local` before assigning any of them, so
  # `local arm="$1" ... name="$prefix-$arm-$n"` dies on `arm: unbound variable`.
  local arm="$1"
  local n="$2"
  local dir="$cells/$arm-$n"
  local name="$name_prefix-$arm-$n"
  echo "────────────────────────────────────────────────────────────"
  echo "run $n/3 — $arm    session dir: $dir    name: $name"
  echo "prompt: $prompt"
  echo

  if [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "error: $dir already holds a transcript." >&2
    echo "       Move it aside, or use --variant NAME to write a fresh set:" >&2
    echo "       the profiler reads the first *.jsonl in a dir, so a stale one" >&2
    echo "       would shadow this run." >&2
    exit 3
  fi

  local args=(-ne -ns -e "$bifrost")
  if [ "$arm" = bgrun ]; then args+=(-e ./extension/index.ts); fi
  args+=(--provider bifrost-openai --model anthropic/claude-sonnet-4-6
         --session-dir "$dir" -n "$name" "$prompt")

  if [ "$dry" = 1 ]; then
    echo "  (dry run) pi ${args[*]}"
    echo
    return 0
  fi

  mkdir -p "$dir"
  ( cd "$repo" && pi "${args[@]}" )
  local status=$?

  if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "error: no transcript in $dir (pi exited $status)." >&2
    echo "       A session killed mid-turn writes none. Stopping here so the runs" >&2
    echo "       already captured stay usable." >&2
    exit 4
  fi

  echo "  ok: $(ls "$dir"/*.jsonl 2>/dev/null | wc -l | tr -d ' ') transcript, pi exited $status"
  echo "  now quit that session for good before the next one starts."
  echo
}

for n in 1 2 3; do
  run_one bgrun "$n"
  run_one vanilla "$n"
done

if [ "$dry" = 1 ]; then
  echo "dry run complete — nothing was launched."
  exit 0
fi

echo "────────────────────────────────────────────────────────────"
echo "all six transcripts in place. Profiling."
outdir="$repo/.bench-runs/$tag"
mkdir -p "$outdir"
( cd "$repo" && bun scripts/measure-sessions.ts "$cells"/* ) | tee "$outdir/profile.txt"
( cd "$repo" && bun scripts/measure-sessions.ts "$cells"/* --csv ) > "$outdir/profile.csv"
echo
echo "wrote .bench-runs/$tag/profile.txt and profile.csv"
echo "Also worth running: bun scripts/wake-claims.ts $cells  (did any session claim a wake"
echo "it had not received?) Then hand the profile back and the manifest follows."
