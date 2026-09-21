#!/usr/bin/env bun
/**
 * Validates a PR title (or any commit subject) against Conventional Commits.
 *
 * Why the PR title and not branch commits: this repo squash-merges, so the PR
 * title becomes the single commit subject on `main`, and that subject is exactly
 * what release-please parses. Intermediate branch commits never reach `main`, so
 * validating them would reject working history for no benefit.
 *
 * Why the type vocabulary comes from release-please-config.json: two lists would
 * drift. A type added to `changelog-sections` becomes valid in a title
 * immediately; a type removed there stops being accepted. One source of truth —
 * and it is the same file that decides which types get a changelog section.
 *
 * Fails CLOSED: a missing or unusable config is an error, not a free pass, since
 * a guardrail that silently stops guarding is worse than one that is noisy.
 *
 * Usage:
 *   bun scripts/check-conventional-commit.ts "feat(ci): add a thing"
 *   printf 'fix: a thing' | bun scripts/check-conventional-commit.ts
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const CONFIG_URL = new URL("../release-please-config.json", import.meta.url);
const CONFIG_PATH = basename(CONFIG_URL.pathname);

interface Section {
  type?: unknown;
}

/** GitHub renders `::error …::` as an annotation; elsewhere it is plain noise. */
const IN_ACTIONS = process.env.GITHUB_ACTIONS === "true";

function fail(message: string, detail?: string): never {
  if (IN_ACTIONS) {
    console.error(`::error title=Non-conventional title::${message}`);
  } else {
    console.error(`error: ${message}`);
  }
  if (detail) console.error(`\n${detail}`);
  process.exit(1);
}

function readConfig(): { "changelog-sections"?: Section[] } {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_URL, "utf8");
  } catch {
    return fail(
      `${CONFIG_PATH} is unreadable — it is the source of the valid commit types.`,
    );
  }
  try {
    return JSON.parse(raw) as { "changelog-sections"?: Section[] };
  } catch (err) {
    return fail(`${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`);
  }
}

function typesFrom(config: { "changelog-sections"?: Section[] }): string[] {
  const sections = config["changelog-sections"];
  const types = Array.isArray(sections)
    ? sections
        .map((section) => section?.type)
        .filter((type): type is string => typeof type === "string")
    : [];
  if (types.length === 0) {
    return fail(
      `${CONFIG_PATH} declares no changelog-sections[].type — every title would be rejected.`,
    );
  }
  return types;
}

function readMessage(): string {
  const arg = process.argv.slice(2).join(" ").trim();
  if (arg) return arg;
  // No argument: accept a commit message on a pipe, but never block on a TTY.
  if (!process.stdin.isTTY) {
    try {
      return readFileSync(0, "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

const types = typesFrom(readConfig());

// Conventional Commits validates the SUBJECT, so only the first line is checked.
// That makes this script equally usable on a PR title (always single-line) and on
// a raw commit message (header + body).
const message = readMessage();
const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";

if (!subject) {
  fail("no commit subject or PR title given. Pass it as an argument or on stdin.");
}

// type(scope)!: description  — scope optional, `!` optional, description required.
// `: ` (colon + space) is mandatory per the spec; a bare `type:text` is rejected.
const pattern = new RegExp(
  `^(${types.join("|")})(?:\\(([^()\\s]+)\\))?(!)?: (.+)$`,
);

if (pattern.test(subject)) {
  console.log(`ok: ${subject}`);
  process.exit(0);
}

const example = `fix(ci): grant pull-requests: write`;
fail(
  `"${subject}" is not a Conventional Commit.`,
  [
    `Valid types: ${types.join(", ")}`,
    `Format:      <type>(<scope>)!: <description>   e.g. "${example}"`,
    "",
    "The type must be lowercase and followed by a colon and a space; the scope is",
    "optional; `!` marks a breaking change.",
    "",
    "Why this is enforced: release-please derives both the version bump and the",
    "changelog from this message. A title it cannot parse gets no changelog entry",
    "and cannot trigger a release on its own — it is dropped silently.",
    "",
    "Note: GitHub's auto-generated Revert \"...\" title is not conventional.",
    'Rewrite it as `revert: <description>` so the revert reaches the changelog.',
  ].join("\n"),
);
