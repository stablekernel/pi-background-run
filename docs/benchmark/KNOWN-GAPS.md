# Known gaps — the queue for the dogfooding work

Written 2026-09-28 from three adversarial reviews of the branch and worktree, so the findings outlive
the session that produced them. Each item names its evidence so it can be re-verified rather than
trusted. Ordering is by what would bite first.

The reviews were: a secrets/sensitive-data audit, a review of the behaviour branch, and a usability
audit of this tooling. What they verified as **working** is worth recording too, because it bounds how
much of the above is guesswork: the profiler reproduces committed numbers byte-for-byte for six of
seven cells, the fixture-hash method is real, `.bench-runs/` and `.pi-bgrun/` are properly ignored, no
credential material is committed anywhere, and no number in `BENCHMARK.md` or `results.md` was found
fabricated — the failures below are provenance and correctness gaps, not invented figures.

## Blockers — a newcomer cannot proceed

| # | gap | evidence | status |
|---|---|---|---|
| B1 | **Cell 1's fixture cannot be regenerated.** `/private/tmp/red-tail-fixture` (sha `0bfe00ed1d9866b9`) has no recorded recipe, and the committed generator now emits different bytes: `a60cd7b` added a conditional import line plus a blank line, so with `DUMMY_CAUSE_MODULE=0` the planted assertion shifts `part-02.test.ts:58` → `:59`. Regenerating at HEAD gives `dedf28f736923ad8`. The same applies to the pilot fixture `8bf97128414cba0b`. | `runs/red-tail-short/RUNSHEET.md:12` gives the shape, not the knobs; `method.md`'s fixture table omits this fixture | **open** — either record every fixture's exact env knobs and the generator commit, or commit the fixture bytes themselves. Cell 1 and the pilot are otherwise unreproducible |
| B2 | **The runner's own first command fails.** `./run-cell.sh red-tail-short --dry-run` — the command `START-HERE.md:25` tells a newcomer to run — exits 3 because the refusal guard runs before the dry-run branch, and every cell dir already holds transcripts. A dry run launches nothing, so it cannot shadow anything. | `run-cell.sh:95-102` guards; the dry-run return is at `:113-115` | **open**, cheap: let `--dry-run` skip the guard |
| B3 | ~~Nothing runs on another machine: the `bifrost` extension path was hardcoded.~~ | `run-cell.sh:63` | **fixed** — defaults to `$HOME/.pi/...`, overridable via `PI_BIFROST_EXTENSION`. Still undocumented: the provider/model literals, and that a live `pi` is required |
| B4 | **The outstanding experiment can't be run without editing the runner.** Model and provider are literals, so the capability ladder (`haiku-4-5` → `sonnet-4-6` → `opus-5`) needs either a code edit mid-battery or hand-transcribed commands. | `run-cell.sh:36-48, 106`; the ladder is 'not run' throughout `results.md` | **open** — add `--model`/`--provider` |

## Confusions — a newcomer would proceed wrongly

| # | gap | evidence | status |
|---|---|---|---|
| C1 | `results.md` contradicts itself: `:3-4` says the file is "empty by design … until a cell actually runs" (it holds 472 lines of results); the Status table at `:27-41` still lists `red-tail-short` and `long-buried` as not run and omits `trace-root` entirely; `:440` says what remains is those two cells. | same file, three places | **open** — Status is now the most misleading section in the repo |
| C2 | The runner's contract lives only in its own header, and the page documenting it is orphaned: nothing links to `START-HERE.md`, `method.md`'s Procedure still describes the manual flow, and `START-HERE:12` says "Next: trace-root, then long-buried — both staged" while both are measured. The `--arms` flag, the refusal guard, the interleaving trade-off and the `.bench-runs/` destination are invisible to a browsing reader. | `grep -rn START-HERE docs README.md` matches only itself; `grep -c run-cell method.md` = 0 | **open** |
| C3 | ~~`red-tail-short/profile.csv` does not reproduce with the current profiler~~ — `reprofile.csv` did. | the audit reproduced the mismatch | **fixed** — profiles regenerated from the transcripts during the redaction |
| C4 | The fixture hash does not pin the workload: the command also runs this repo's own tests, whose count moved 252 → 270 during the week (`Ran 260 tests` in Cell 1, `570` in Cell 4). A "same fixture hash" re-run is not the same workload. | `run-cell.sh:64`; transcript totals | **open** — pin the repo-suite revision, or state the drift in every record |
| C5 | The per-session run manifest `method.md:193-196` mandates exists for no cell, so rung, reasoning effort and machine load are unrecoverable and a re-run cannot be proven comparable. `red-tail-short/` also lacks the `wake-claims.csv` its `CELL.md` quotes; the two pointer-variant cells lack a `CELL.md` of their own (their record is in `long-buried/CELL.md`). | `find docs -iname '*manifest*'` finds only the pilot's | **open** |
| C6 | `red-tail-short/RUNSHEET.md:18-19` still says "96 lines … lines 72–76" while its `CELL.md` says "95 lines, line 70" *and* claims "the sheet has been corrected with the same note" — no such note exists. | grep for `stale` finds nothing | **open** |
| C7 | `measure-sessions.ts` writes `session` into the column its header calls `row` (`:795` vs `:829`), so a consumer reading by header name gets a bogus first column. Reproduces in every committed profile. | header vs rows | **open**, cosmetic but machine-visible |
| C8 | Two instrument checks cite things outside the repo: a `pi-bgrun.ptyshape` checkout that no longer exists, and `.pi-bgrun/jobs/*.log` (git-ignored). The *scripts* self-generate their fixtures, so the checks are reproducible — the citations are what rot. | `results.md` trace-path entry | **open**, low |

## The pointer question itself

The three-way cell result (no pointer 3/4/4 calls and 18,760 chars; wrong pointer 5/5/6 and 28,633;
correct pointer 5/5/8 and 33,799) is written up in `BENCHMARK.md` and in
`runs/long-buried/CELL.md`, and tracked for further work in product issue #33. Three directions are
recorded there: prompt/tool shaping, richer pointers, or documenting the feature as conditional and
possibly deprecating it. The related *defect* work — the evidence rule across all three presets — is
issue #34.

## The history rewrite, deliberately not done

Two pilot transcripts were deleted from the tree in `57e4218` but remain fetchable as blobs
`8dc540974b3e11cdb0bb91d7675b88681219763e` and `a94b186b8f8f099d35cb656bb292b65d0917723e`, carrying
the same personal context that was just redacted everywhere else. Removed files stay in history, so a
clone still contains them. Purging needs a rewrite of this branch (unpushed, so cheap), then reflog
expiry and `gc` — a deliberate step, not a side effect of a redaction commit.

The verbatim pre-redaction transcripts are kept outside any repository at
`~/.pi-bgrun-bench-transcripts/`, so nothing was lost by redacting.
