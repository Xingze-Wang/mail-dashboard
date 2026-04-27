#!/usr/bin/env node
// Lint rule for Tier 5 of docs/DATA_INTEGRITY_PLAN.md.
//
// Bans raw `fetch(<url>, { method: "POST"|"PATCH"|"DELETE"|"PUT" })`
// outside src/lib/api-client.ts. New code must use apiPost/apiPatch/
// apiDelete/apiPut from there, which throw on !res.ok so swallowed
// errors become grep-able.
//
// Old code is grandfathered: this script reports COUNTS, not failures.
// The exit code is 0 unless it finds a NEW violation in a file that
// imports from "@/lib/api-client" (i.e. someone touched the file but
// only wrapped some of the calls).
//
// Run: node scripts/lint-fetch.mjs   (or `pnpm lint:fetch`)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const ALLOWED_PREFIXES = [
  join("src", "lib", "api-client.ts"),
];
const NON_GET_FETCH = /\bfetch\s*\([^)]*method\s*:\s*["'](POST|PATCH|DELETE|PUT)["']/i;
const HAS_API_CLIENT_IMPORT = /from\s+["']@\/lib\/api-client["']/;

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

let totalRaw = 0;
const blockingHits = [];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOWED_PREFIXES.some((p) => rel === p)) continue;

  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const usesApiClient = HAS_API_CLIENT_IMPORT.test(content);

  let fileHits = 0;
  lines.forEach((line, i) => {
    if (NON_GET_FETCH.test(line)) {
      fileHits++;
      totalRaw++;
      if (usesApiClient) {
        // File knows about the wrapper but still has a raw call —
        // that's a partial migration. Block on these.
        blockingHits.push({ file: rel, lineNumber: i + 1, line: line.trim() });
      }
    }
  });
}

console.log(`Total raw POST/PATCH/DELETE/PUT fetches in src/: ${totalRaw}`);
console.log(`(grandfathered — only failures are partial migrations)`);

if (blockingHits.length === 0) {
  console.log("OK: no partial migrations.");
  process.exit(0);
}

console.error(`\nFAIL: ${blockingHits.length} raw fetch call(s) in files that already import @/lib/api-client.`);
console.error(`This means someone half-migrated. Use apiPost/apiPatch/apiDelete/apiPut from @/lib/api-client.`);
console.error(`See docs/DATA_INTEGRITY_PLAN.md Tier 5.\n`);
for (const h of blockingHits) {
  console.error(`  ${h.file}:${h.lineNumber}  ${h.line}`);
}
process.exit(1);
