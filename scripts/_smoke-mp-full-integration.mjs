// Full MP integration smoke.
//
// What it does (all in one run):
//   1. Load .env.local (MP_API_TOKEN, MP_API_BASE, Supabase creds, CRON_SECRET).
//   2. Run syncRecentOutbound({ since: now - 14d }) LOCALLY against prod DB via
//      a child tsx process (path-alias resolution + ESM/CJS interop is too
//      hairy to do inline from .mjs).
//   3. Compute getMpConversionMatrix({ since: 14d ago }) and print all 5 numbers
//      plus per-rep rollup. Assert matrix.registered > 0 (earlier smoke at
//      30 emails saw 11 matches).
//   4. Hit the deployed prod cron endpoint
//        https://calistamind.com/api/cron/sync-miracleplus-contacts
//      with Bearer $CRON_SECRET. Assert 200 + JSON body.
//
// Usage:
//   node scripts/_smoke-mp-full-integration.mjs

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 1. Load .env.local ────────────────────────────────────────────────
const envFile = readFileSync(
  new URL("../.env.local", import.meta.url).pathname,
  "utf8",
);
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const need = [
  "MP_API_TOKEN",
  "MP_API_BASE",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "CRON_SECRET",
];
for (const k of need) {
  if (!process.env[k]) {
    console.error(`Missing env: ${k} — check .env.local.`);
    process.exit(2);
  }
}

const repoRoot = new URL("..", import.meta.url).pathname;

/**
 * Run a TS snippet via tsx in a child process so we get clean module
 * resolution (incl. tsconfig path aliases) without ESM/CJS gymnastics.
 * Output: the snippet must console.log a JSON line on stdout; we parse
 * the last JSON-looking line.
 */
function runTs(name, ts) {
  // Write the snippet INSIDE scripts/ so tsconfig path aliases like
  // `@/lib/...` resolve correctly relative to repoRoot.
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const file = join(scriptsDir, `_smoke-mp-${name}-tmp.ts`);
  writeFileSync(file, ts);
  try {
    const result = spawnSync(
      "npx",
      ["tsx", file],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        timeout: 540_000,
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`[${name}] stderr:`, result.stderr.slice(-1000));
      throw new Error(`${name} exited ${result.status}`);
    }
    const lines = result.stdout.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim();
      if (ln.startsWith("{") || ln.startsWith("[")) {
        try {
          return JSON.parse(ln);
        } catch {
          /* try next */
        }
      }
    }
    console.error(`[${name}] stdout:`, result.stdout.slice(-1000));
    throw new Error(`${name}: could not parse JSON result line`);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

// ── 2. Run local sync (last 14d) ──────────────────────────────────────
console.log("\n=== STEP 1: syncRecentOutbound (14d window) ===");
const t0 = Date.now();
const syncResult = runTs(
  "sync",
  `
import { syncRecentOutbound } from "@/lib/miracleplus-sync";
(async () => {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const r = await syncRecentOutbound({ since });
  console.log(JSON.stringify(r));
})();
`,
);
console.log(`  duration: ${Date.now() - t0}ms`);
console.log(`  checked:  ${syncResult.checked}`);
console.log(`  found:    ${syncResult.found}`);
console.log(`  errors:   ${syncResult.errors}`);
console.log(`  api ms:   ${syncResult.ms}`);

// ── 3. Conversion matrix ─────────────────────────────────────────────
console.log("\n=== STEP 2: getMpConversionMatrix (14d window) ===");
const matrix = runTs(
  "matrix",
  `
import { getMpConversionMatrix } from "@/lib/canonical-counts";
(async () => {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const m = await getMpConversionMatrix({ since });
  console.log(JSON.stringify(m));
})();
`,
);
console.log(`  totalEmailed:            ${matrix.totalEmailed}`);
console.log(`  registered (MP-matched): ${matrix.registered}`);
console.log(`  submittedApplication:    ${matrix.submittedApplication}`);
console.log(`  wechatAdded:             ${matrix.wechatAdded}`);
console.log(`  bothWechatAndSubmitted:  ${matrix.bothWechatAndSubmitted}`);
if (matrix.perRep && matrix.perRep.length > 0) {
  console.log("  perRep:");
  for (const r of matrix.perRep) {
    console.log(
      `    rep#${r.rep_id}: emailed=${r.totalEmailed} mp=${r.registered} submitted=${r.submittedApplication} wechat=${r.wechatAdded}`,
    );
  }
}

let assertion1 = matrix.registered > 0;
if (!assertion1) {
  console.warn(
    "\n  ⚠ matrix.registered = 0. Either (a) sync didn't write rows, " +
      "(b) email-mask is hiding all matches, or (c) no overlap in this 14d " +
      "window. Earlier smoke at 30 emails saw 11 matches — investigate if " +
      "you expected >0.",
  );
}

// ── 4. Hit prod cron endpoint ────────────────────────────────────────
console.log("\n=== STEP 3: hit prod cron endpoint ===");
const cronUrl = "https://calistamind.com/api/cron/sync-miracleplus-contacts";
const cronResp = await fetch(cronUrl, {
  method: "GET",
  headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  signal: AbortSignal.timeout(280_000),
});
const cronStatus = cronResp.status;
const cronText = await cronResp.text();
let cronBody;
try {
  cronBody = JSON.parse(cronText);
} catch {
  cronBody = { raw: cronText.slice(0, 500) };
}
console.log(`  HTTP:    ${cronStatus}`);
console.log(`  body:    ${JSON.stringify(cronBody, null, 2)}`);

const assertion2 = cronStatus === 200 && cronBody?.ok === true;

// ── 5. Summary ───────────────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
console.log(
  `  sync wrote rows:     ${syncResult.found > 0 ? "YES" : "NO"} (${syncResult.found}/${syncResult.checked})`,
);
console.log(
  `  matrix has matches:  ${assertion1 ? "YES" : "NO (registered=0)"}`,
);
console.log(`  prod cron 200 + ok:  ${assertion2 ? "YES" : "NO"}`);
if (!assertion2) process.exit(1);
