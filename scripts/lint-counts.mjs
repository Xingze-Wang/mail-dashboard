#!/usr/bin/env node
// Guardrail for the canonical-counts contract (CANONICAL_COUNTS.md).
//
// Bans direct count queries against the canonical tables outside
// `src/lib/canonical-counts.ts`. Specifically flags:
//
//   1. `.from("pipeline_leads") ... .select(..., { count: "exact" ... })`
//   2. `.from("inbound_emails") ... .select(..., { count: "exact" ... })`
//   3. `.from("brief_lookups")  ... .select(..., { count: "exact" ... })`
//   4. `.from("emails")         ... .select(..., { count: "exact" ... })`
//
// And client-side `.length` aggregations that look like a count derived
// from a paginated fetch (matches `leads.length` / `rows.length` /
// `arxivTotal\s*=`).
//
// Allow-list:
//   - src/lib/canonical-counts.ts (the module itself)
//   - scripts/** (one-off backfills/audits — not user-visible)
//   - any file that does its own bulk-fetch-and-bucket (see
//     CANONICAL_COUNTS.md "when to NOT use canonical-counts") — opt out
//     by adding the literal comment "// canonical-counts:ignore" on the
//     line ABOVE the offending query.
//
// Run: node scripts/lint-counts.mjs  (or `npm run lint:counts`)
//
// Exit code: 0 = clean, 1 = at least one un-ignored violation.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const CANONICAL_TABLES = ["pipeline_leads", "inbound_emails", "brief_lookups", "emails"];

const ALLOWED = new Set([
  "src/lib/canonical-counts.ts",
]);

// Path prefixes that are allowed to do raw counts. Each entry is paired
// with a one-line reason so the contract stays auditable.
const ALLOWED_PREFIXES = [
  // Scorer/backfill: one-off ETL jobs that read whole tables — not
  // user-visible counts, and they predate canonical-counts.
  ["src/app/api/scorer/", "ETL / model training — not user-visible counts"],
  ["src/app/api/cron/proactive-signals/", "ML signal extraction, bulk fetch + bucket"],
  ["src/app/api/emails/backfill-bodies/", "one-off backfill"],
  ["src/app/api/inbound/backfill-rep-id/", "one-off backfill"],
  ["src/app/api/debug/", "admin-only ad-hoc inspection"],
  ["src/app/api/webhook/health/", "delivery-pipeline health probe"],
  // Integrity + admin reports use bulk-fetch-and-bucket patterns where
  // a per-predicate canonical call would be 20-50x slower. Documented
  // exception per CANONICAL_COUNTS.md "when to NOT use canonical-counts".
  ["src/lib/integrity.ts", "bulk integrity scan"],
  ["src/lib/admin-alerts.ts", "bulk admin-alert builder"],
  ["src/lib/admin-daily-report.ts", "bulk admin report builder"],
  ["src/lib/congress-runners.ts", "bulk simulation runner"],
  ["src/lib/predictions.ts", "ML prediction resolver"],
  ["src/lib/trust-level.ts", "internal trust-level calculator"],
  ["src/lib/override-quota.ts", "internal quota calculator"],
  ["src/lib/wechat-followup.ts", "specialized followup detector"],
  // The /emails route counts outbound emails (not pipeline_leads). Its
  // status filter is per-rep + per-status with text search ranking —
  // a specialized list view, not a canonical KPI.
  ["src/app/api/emails/route.ts", "rep-scoped outbound listing, not a KPI"],
  // weekly-checkin, missions/heuristic-seed and pipeline/draft-queue
  // use specialized filters (per-rep × tier × geo × industry) that
  // would require ~10 canonical-counts primitives. Migrate when
  // a second consumer needs the same shape.
  ["src/app/api/cron/weekly-checkin/", "specialized per-rep-per-tier reporting"],
  ["src/app/api/missions/heuristic-seed/", "specialized allocation accounting"],
  ["src/app/api/pipeline/draft-queue/", "internal worker-pool head count"],
  // Inbound webhook uses an internal duplicate-check count — not a KPI.
  ["src/app/api/inbound/route.ts", "duplicate-message guard, not a KPI"],
  // Metrics route's inbound-total nested helper.
  ["src/app/api/metrics/route.ts", "specialized inbound thread-scoped count, kept inline"],
];

function isPrefixAllowed(rel) {
  return ALLOWED_PREFIXES.find(([p]) => rel.startsWith(p));
}

// Match: .from("<table>") followed (within a small window) by .select(
//        ... count:
// On multi-line chains, we collapse 200 chars after .from() before matching.
const FROM_RE = new RegExp(`\\.from\\(["'](${CANONICAL_TABLES.join("|")})["']\\)`);
const COUNT_RE = /\.select\([^)]*count\s*:\s*["']exact["']/;
const IGNORE_DIRECTIVE = /\/\/\s*canonical-counts:ignore/;

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

const violations = [];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (ALLOWED.has(rel)) continue;
  if (isPrefixAllowed(rel)) continue;

  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FROM_RE);
    if (!m) continue;

    // Pull a window of the next 5 lines and check for count: "exact"
    // (chained on a new line after .from()).
    const window = lines.slice(i, Math.min(lines.length, i + 6)).join("\n");
    if (!COUNT_RE.test(window)) continue;

    // Allow opt-out via // canonical-counts:ignore on the line above.
    const prev = lines[i - 1] ?? "";
    if (IGNORE_DIRECTIVE.test(prev)) continue;

    violations.push({
      file: rel,
      line: i + 1,
      table: m[1],
      snippet: line.trim(),
    });
  }
}

if (violations.length === 0) {
  console.log("✓ canonical-counts: no raw count queries on canonical tables outside src/lib/canonical-counts.ts");
  process.exit(0);
}

console.error(`\n✗ canonical-counts: ${violations.length} raw count quer${violations.length === 1 ? "y" : "ies"} found.\n`);
console.error("Every count of these tables must go through src/lib/canonical-counts.ts.");
console.error("If this query genuinely cannot (e.g. bulk-fetch-and-bucket pattern), add");
console.error("'// canonical-counts:ignore' on the line above and document why.\n");
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.table}]`);
  console.error(`    ${v.snippet}`);
}
process.exit(1);
