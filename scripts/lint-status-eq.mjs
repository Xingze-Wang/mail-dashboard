#!/usr/bin/env node
// Lint rule for Tier 2 of docs/DATA_INTEGRITY_PLAN.md.
//
// emails.status is latest-event-wins, so any analytics query asking
// "was this clicked?" via .eq("status", "clicked") undercounts when a
// click was overwritten by a later complaint or bounce. Fix: read from
// the email_history view instead.
//
// This script greps for the antipattern in src/ and exits non-zero
// when it finds a hit outside the explicitly-allowed inbox path
// (where "latest visible state" is what the user actually wants).
//
// Run: node scripts/lint-status-eq.mjs   (or wired into pnpm lint:integrity)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const ALLOWED_PREFIXES = [
  // Inbox UI displays the *current* email status to the human reader.
  // Latest-event-wins is what we want there.
  join("src", "app", "inbox") + sep,
];
const PATTERNS = [
  /\.eq\(\s*["']status["']\s*,\s*["']clicked["']\s*\)/,
  /\.eq\(\s*["']status["']\s*,\s*["']bounced["']\s*\)/,
  /\.eq\(\s*["']status["']\s*,\s*["']complained["']\s*\)/,
  /\.eq\(\s*["']status["']\s*,\s*["']opened["']\s*\)/,
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      yield* walk(full);
    } else if (/\.(t|j)sx?$/.test(entry)) {
      yield full;
    }
  }
}

const hits = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue;
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    for (const re of PATTERNS) {
      if (re.test(line)) {
        hits.push({ file: rel, lineNumber: i + 1, line: line.trim() });
      }
    }
  });
}

if (hits.length === 0) {
  console.log("OK: no banned `.eq(\"status\", \"<event>\")` patterns outside inbox");
  process.exit(0);
}

console.error(`FAIL: ${hits.length} banned status-equality usage(s) found.`);
console.error(
  `These read emails.status (latest-event-wins) and silently undercount.\n` +
    `Use the email_history view (was_clicked / was_bounced / ...).\n` +
    `See docs/DATA_INTEGRITY_PLAN.md Tier 2.\n`,
);
for (const h of hits) {
  console.error(`  ${h.file}:${h.lineNumber}  ${h.line}`);
}
process.exit(1);
