# Releasing pi-background-run

Version numbers, `CHANGELOG.md`, and the GitHub Release notes are all derived from
Conventional Commits, via [release-please](https://github.com/googleapis/release-please).
Nobody edits a version by hand.

Every merge to `main` runs release-please, which keeps **one** open **Release PR**
holding the `package.json` bump plus the changelog entry for everything merged since
the last tag. Ordinary merges only *update* that PR — nothing is published. Merging
it **is** the release: release-please tags the commit and creates the GitHub Release
with generated notes, which fires `release.yml`'s `release: published` trigger to
publish to npm over OIDC.

## What triggers a release

| Commit | Release PR | Version |
| --- | --- | --- |
| `fix:` | yes | patch |
| `feat:` | yes | minor |
| `deps:` | yes | patch |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` | yes | minor |
| `refactor:` `docs:` `test:` `ci:` `build:` `chore:` `style:` | no | — |
| no prefix, e.g. `Address review findings (#11)` | no | — |

An unprefixed commit is ignored outright: **no changelog entry, and it cannot trigger
a release on its own.** `pr-title.yml` exists so that is a red check on the PR instead
of a silent omission.

A `!` bumps the *minor* while pre-1.0 (`bump-minor-pre-major: true`), so a breaking
change never ends pre-release status by accident. Forcing an exact version takes a
`Release-As:` footer in a commit *body*:
`git commit --allow-empty -m "chore: release 2.0.0" -m "Release-As: 2.0.0"`.

GitHub's auto-generated `Revert "feat: …"` title is not conventional and would be
dropped; rewrite it as `revert: <description>`.

## Enforcement

`pr-title.yml` rejects a PR title release-please cannot parse.
`bun run lint:pr-title "feat(ci): add a thing"` runs the same check locally.

The checker is `scripts/check-conventional-commit.ts`. It reads its type vocabulary
from `release-please-config.json`'s `changelog-sections`, so there is one source of
truth: adding a type there immediately permits it in a title. It fails **closed** — an
unreadable or empty config is an error, never a free pass.

It runs on `opened`, `edited`, `reopened`, and `synchronize`; `edited` is what makes a
bad title recoverable, since fixing the title re-runs the check. Making
`conventional-title` a required check is optional and safe.

## Commit and merge conventions

**Squash merge, and nothing else.** This is structural, not cosmetic: the squash
collapses a PR to one commit whose subject is the *title*, and that subject is what
release-please parses. Rebase would land every branch commit individually (WIP
subjects would enter the changelog and the title check would be irrelevant); a merge
commit adds a fixed non-conventional subject that release-please ignores.

These settings are required, and **are currently set as required** (applied
2026-09-21, verified by reading them back from the API):

| Setting | Required | Why |
| --- | --- | --- |
| `allow_squash_merge` | `true` | the only merge method |
| `allow_merge_commit` | **`false`** | a merge commit adds a fixed non-conventional subject release-please ignores |
| `allow_rebase_merge` | **`false`** | rebase lands every branch commit individually, so WIP subjects enter the changelog |
| `squash_merge_commit_title` | **`PR_TITLE`** | see below — the default does *not* always use the PR title |
| `squash_merge_commit_message` | **`BLANK`** | the default appends a dump of branch commit messages to the squash body |

If they ever need restoring — a repo transfer, a mistaken revert — this is the
command, and it is safe to re-run:

```
gh api -X PATCH repos/stablekernel/pi-background-run \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F squash_merge_commit_title=PR_TITLE \
  -F squash_merge_commit_message=BLANK
```

`PR_TITLE` is the load-bearing one. The default `COMMIT_OR_PR_TITLE` means *the
commit's title if only one commit, otherwise the PR title* — so on a **single-commit
PR the squash subject is the branch commit's message**, which `pr-title.yml` never
sees. A one-commit PR with a good title and a sloppy commit message would land a
non-conventional subject and vanish from the changelog.

`COMMIT_MESSAGES` is the default body and should go too: it appends the branch's
commit messages to the squash body, where release-please may parse them as extra
changelog entries.

`required_linear_history` is **not** enabled and `enforce_admins` is `true`, so
nothing else stops a merge commit or a rebase — these settings are the only guard.

## Configuration

| File | Holds |
| --- | --- |
| `release-please-config.json` | Release type, tag format, changelog sections. |
| `.release-please-manifest.json` | Last released version, used to find commits since. |

`include-component-in-tag: false` is **required**. The manifest default looks for
`pi-background-run-vX.Y.Z`, which matches none of this repo's `vX.Y.Z` tags; the run
fails rather than guessing.

Changelog sections are declared explicitly so only user-visible change surfaces:
`chore`, `docs`, `refactor`, `test`, `ci`, `build`, and `style` are `hidden`, which is
why a refactor-heavy release still reads as a short list of features and fixes.

`CHANGELOG.md` is deliberately **not** in `package.json` `files[]`, so it does not ship
in the npm tarball — the allowlist still emits 7 files.

## The one secret

`release-please.yml` uses `secrets.RELEASE_PLEASE_TOKEN`, falling back to
`GITHUB_TOKEN` if unset. It should be a **fine-grained PAT scoped to this repository
only**, with:

- **Contents: Read and write** — pushes the changelog commit, creates the tag and Release
- **Pull requests: Read and write** — opens and updates the Release PR

Why it is needed at all: `main` requires the `lint-test` status check and
`enforce_admins` is `true`, so there is no bypass. Checks only report from a real
workflow run, and `GITHUB_TOKEN`-created events start none — so a `GITHUB_TOKEN`
Release PR can never report `lint-test` and can never be merged.

It also removes a whole class of machinery. Because a PAT-created Release carries a
*user* identity, `release: published` fires normally and **`release.yml` needs no
changes**; under `GITHUB_TOKEN` that event is suppressed, which would otherwise
require chaining `release.yml` as a reusable workflow — and, since npm validates a
`workflow_call` publish against the *calling* workflow's filename, registering
`release-please.yml` as a **second trusted publisher on both packages**.

So: **npm trusted publishing needs no changes.** `release.yml` remains the publisher
and stays registered as-is. A fine-grained PAT expires, so it needs periodic rotation
— the one recurring cost of this design, and the reason a GitHub App token
(short-lived per run, no expiry) would be strictly better if the org is willing to
own one. `release-please`'s own docs recommend a PAT for exactly the check-reporting
reason above.

Until the secret exists the fallback keeps release-please running, so Release PRs
still open — they just cannot be merged.

## See also

- `release.yml` — untouched by the release-automation work: dual publish (unscoped
  primary + scoped alias) and the version-consistency guard that refuses to publish
  when the tag and `package.json` disagree.
- `pr-title.yml` — the Conventional Commits check, with its logic in
  `scripts/check-conventional-commit.ts`.
- README: [Status](../README.md#status) — pre-1.0, which is why
  `bump-minor-pre-major` is set.
