#!/usr/bin/env bun
/**
 * Sanitize committed session transcripts without disturbing any measured number.
 *
 * Why this exists: the transcripts under `docs/benchmark/runs/*\/sessions/` are real agent
 * sessions, kept because traceability is the whole point of them. But a pi session records the
 * *injected project context* too, which for this machine includes the contents of a personal
 * `~/.AGENTS.md`, the author's home path, and a machine-specific temp path. Those are personal,
 * not scientific.
 *
 * The rule here is **length-preserving replacement**: every redacted string is swapped for a
 * placeholder of exactly the same character count. That matters more than it looks. `ctx_chars`
 * and the token counts in `profile.csv` are computed *from these files*, so a redaction that
 * shortened them would silently invalidate every published number, and re-profiling would move
 * figures quoted in `BENCHMARK.md`, `results.md` and the tracking issue. Same-length swaps keep
 * the analysis bit-identical while removing the personal text.
 *
 * The wording of the placeholders is deliberately blunt: a reader of a raw transcript should see
 * that something was removed and why, not a plausible-looking fiction.
 *
 * Usage:
 *   bun scripts/sanitize-transcripts.ts              # rewrite in place (idempotent)
 *   bun scripts/sanitize-transcripts.ts --check      # report residue, change nothing, exit 1 if found
 *
 * Idempotent: placeholders do not match the patterns they replace.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const HOME_USER = /\/Users\/[A-Za-z0-9._-]+/g;
const HOME_USER_PLACEHOLDER = "/Users/benchmark-runner1"; // same 25 characters
const TEMP_HASH = /\/var\/folders\/[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/g;
const AGENTS_BLOCK = /(<project_instructions\b[^>]*>)([\s\S]*?)(<\/project_instructions>)/g;
const AGENTS_NOTICE = "[redacted: personal agent configuration, not part of this benchmark]";
const PERSONAL_MARKERS = ["context-mode", "MANDATORY routing", "kendex", "pi-hermes"];

export interface RedactionCounts {
  files: number;
  homePaths: number;
  tempPaths: number;
  agentBlocks: number;
}

function redactAgentsBlock(body: string): string {
  // Keep the exact character count: notice first, then pad. The padding is spaces so that the
  // transcript still reads as a single redaction rather than a wall of filler.
  if (body.length <= AGENTS_NOTICE.length) return AGENTS_NOTICE.slice(0, body.length);
  return AGENTS_NOTICE + " ".repeat(body.length - AGENTS_NOTICE.length);
}

export function sanitizeText(text: string, counts: RedactionCounts): string {
  let out = text.replace(HOME_USER, (m) => {
    counts.homePaths += 1;
    // preserve length even for unusually long or short usernames
    return m.length === HOME_USER_PLACEHOLDER.length
      ? HOME_USER_PLACEHOLDER
      : "/Users/" + "x".repeat(m.length - "/Users/".length);
  });
  out = out.replace(TEMP_HASH, (m) => {
    counts.tempPaths += 1;
    const prefix = m.slice(0, m.lastIndexOf("/") + 1);
    return prefix + "x".repeat(m.length - prefix.length);
  });
  out = out.replace(AGENTS_BLOCK, (_m, open: string, body: string, close: string) => {
    counts.agentBlocks += 1;
    return open + redactAgentsBlock(body) + close;
  });
  return out;
}

function sessionFiles(root: string): string[] {
  const runs = join(root, "docs", "benchmark", "runs");
  const out: string[] = [];
  for (const cell of readdirSync(runs)) {
    const sessions = join(runs, cell, "sessions");
    let arms: string[];
    try {
      if (!statSync(sessions).isDirectory()) continue;
      arms = readdirSync(sessions);
    } catch {
      continue;
    }
    for (const arm of arms) {
      const dir = join(sessions, arm);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) out.push(join(dir, f));
    }
  }
  return out.sort();
}

export function residue(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(HOME_USER)) if (!m[0].includes("benchmark-runner")) found.push(m[0]);
  for (const m of text.matchAll(TEMP_HASH)) {
    const tail = m[0].slice(m[0].lastIndexOf("/") + 1);
    if (!/^x+$/.test(tail)) found.push(m[0]); // our own placeholder is not residue
  }
  for (const marker of PERSONAL_MARKERS) if (text.includes(marker)) found.push(marker);
  return [...new Set(found)];
}

function main(argv: string[]) {
  const check = argv.includes("--check");
  const root = argv.find((a) => !a.startsWith("--")) ?? process.cwd();
  if (!statSync(root).isDirectory()) {
    console.error(`not a directory: ${root}`);
    process.exit(2);
  }
  const files = sessionFiles(root);
  if (files.length === 0) {
    console.error(`no transcripts found under ${join(root, "docs/benchmark/runs")}/*/sessions/*/`);
    process.exit(2);
  }
  const counts: RedactionCounts = { files: 0, homePaths: 0, tempPaths: 0, agentBlocks: 0 };
  const dirty: string[] = [];

  for (const f of files) {
    const before = readFileSync(f, "utf8");
    if (check) {
      const res = residue(before);
      if (res.length) dirty.push(`${f}  ->  ${res.slice(0, 3).join(", ")}`);
      continue;
    }
    const after = sanitizeText(before, counts);
    if (after !== before) {
      if (after.length !== before.length) {
        console.error(`REFUSING ${f}: length changed ${before.length} -> ${after.length}`);
        process.exit(3);
      }
      writeFileSync(f, after);
      counts.files += 1;
    }
  }

  if (check) {
    if (dirty.length === 0) {
      console.log(`clean: ${files.length} transcripts carry no personal markers`);
      process.exit(0);
    }
    console.log(`residue in ${dirty.length} of ${files.length} transcripts:`);
    for (const d of dirty) console.log("  " + d);
    process.exit(1);
  }

  console.log(
    `sanitized ${counts.files}/${files.length} transcripts: ` +
      `${counts.homePaths} home paths, ${counts.tempPaths} temp paths, ${counts.agentBlocks} embedded config blocks`,
  );
  console.log("length-preserving, so every profiled number is unchanged — verify with:");
  console.log("  bun scripts/measure-sessions.ts <cell>/sessions/*   # compare against the committed profile.csv");
}

if (import.meta.main) main(process.argv.slice(2));
