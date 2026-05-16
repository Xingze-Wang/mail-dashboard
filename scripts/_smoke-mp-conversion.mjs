// Smoke: end-to-end MiraclePlus integration.
//
// What it does:
//   1. Loads .env.local (MP_API_TOKEN + MP_API_BASE + Supabase creds).
//   2. Picks a recent emails.to from prod DB (REACHABLE status).
//   3. Calls MP /open_api/v1/contacts/search?q=<email> directly via fetch.
//   4. Reports: did MP return a hit? Does it have application_progress?
//   5. Runs the full syncContactByEmail (which writes to
//      miracleplus_contacts) + then computes the 5-number conversion
//      matrix via getMpConversionMatrix for the last 90 days.
//   6. PRINT all 5 numbers + one sample contact response VERBATIM.
//
// Acceptable outcomes:
//   - Real numbers → integration works against real data, ship it.
//   - All 5 == 0 + masked emails in MP response → staging masking is
//     hiding real overlap. Integration is correctly built; flip env
//     to prod token + base and the matrix will populate.
//
// Usage:
//   node scripts/_smoke-mp-conversion.mjs

import { readFileSync } from "node:fs";

// ── 1. Load .env.local ────────────────────────────────────────────────
const envFile = readFileSync(
  new URL("../.env.local", import.meta.url).pathname,
  "utf8",
);
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_BASE = (process.env.MP_API_BASE ?? "").replace(/\/+$/, "");
const MP_TOKEN = process.env.MP_API_TOKEN;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env. Check .env.local.");
  process.exit(2);
}
if (!MP_BASE || !MP_TOKEN) {
  console.error("Missing MP_API_BASE / MP_API_TOKEN. Check .env.local.");
  process.exit(2);
}

const REACHABLE = ["delivered", "clicked", "sent", "replied"];

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function mp(path) {
  const r = await fetch(`${MP_BASE}${path}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}`, Accept: "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`MP ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`MP bad JSON: ${text.slice(0, 200)}`); }
}

async function sbWrite(path, payload, prefer = "resolution=merge-duplicates") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Supabase write ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

// ── 2. Pick a recent recipient ────────────────────────────────────────
console.log("\n=== STEP 1: pick a recent recipient ===");
const statusFilter = `status=in.(${REACHABLE.join(",")})`;
const recents = await sb(
  `emails?select=id,to,status,created_at&${statusFilter}&to=not.is.null&order=created_at.desc&limit=5`,
);
if (!Array.isArray(recents) || recents.length === 0) {
  console.error("No recent emails found in prod DB.");
  process.exit(1);
}
const sampleEmail = recents.find((r) => r.to && r.to.includes("@"))?.to;
if (!sampleEmail) {
  console.error("No usable emails.to in the recent sample.");
  process.exit(1);
}
console.log(`Picked: ${sampleEmail}  (status from emails table)`);

// ── 3. Direct MP call ─────────────────────────────────────────────────
console.log("\n=== STEP 2: call MP /contacts/search ===");
const mpResp = await mp(
  `/open_api/v1/contacts/search?q=${encodeURIComponent(sampleEmail)}&per=10`,
);
const hits = mpResp?.data?.contacts ?? [];
console.log(`MP returned: ${hits.length} hits, total=${mpResp?.data?.total}`);
if (hits.length > 0) {
  const c = hits[0];
  console.log("Sample contact (first hit):");
  console.log(JSON.stringify({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    application_progress: c.application_progress,
    application_stage: c.application_stage,
    applications_number: c.applications_number,
    submitted_at: c.submitted_at,
    created_application_at: c.created_application_at,
    project: c.project,
    s_product: c.s_product,
    s_channel: c.s_channel,
    utm_source: c.utm_source,
  }, null, 2));
  console.log(`Has application_progress? ${c.application_progress != null ? "YES → submitted" : "NO"}`);
} else {
  console.log("No MP hit for this email.");
}

// ── 4. Test sync writes to miracleplus_contacts ───────────────────────
console.log("\n=== STEP 3: sync writes mirror table ===");
let synced = 0;
for (const c of hits) {
  const e = typeof c.email === "string" ? c.email.trim().toLowerCase() : null;
  const canonical = e && e.includes("@") && e.replace(/\*/g, "").length > 0 ? e : sampleEmail.trim().toLowerCase();
  await sbWrite("miracleplus_contacts", {
    mp_id: c.id,
    email: c.email ?? null,
    email_canonical: canonical,
    name: c.name ?? null,
    phone: c.phone ?? null,
    application_progress: c.application_progress ?? null,
    application_stage: c.application_stage ?? null,
    applications_number: typeof c.applications_number === "number" ? c.applications_number : null,
    submitted_at: c.submitted_at ?? null,
    created_application_at: c.created_application_at ?? null,
    project: c.project ?? null,
    s_product: c.s_product ?? null,
    s_channel: c.s_channel ?? null,
    utm_source: c.utm_source ?? null,
    raw: c,
    last_seen_at: new Date().toISOString(),
  });
  synced++;
}
console.log(`Wrote ${synced} mirror rows. Total mirror table size:`);
const mirrorAll = await sb("miracleplus_contacts?select=mp_id");
console.log(`  miracleplus_contacts.count = ${mirrorAll.length}`);

// ── 5. Compute conversion matrix client-side (mirroring getMpConversionMatrix) ──
// We re-implement the join here in JS rather than calling the TS module
// because this is a .mjs smoke. The logic mirrors canonical-counts.ts:
// (a) get distinct (to, actor_rep_id) from emails in last 90d;
// (b) get miracleplus_contacts rows whose email_canonical matches;
// (c) get brief_lookups rows where added_wechat=true AND query matches.
console.log("\n=== STEP 4: compute conversion matrix (last 90 days) ===");
const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
const sends = await sb(
  `emails?select=to,actor_rep_id&${statusFilter}&created_at=gte.${since}&to=not.is.null&limit=10000`,
);
const allEmails = new Set();
for (const s of sends) {
  const e = (s.to ?? "").trim().toLowerCase();
  if (e && e.includes("@")) allEmails.add(e);
}
const totalEmailed = allEmails.size;

// Match MP mirror against the email set.
const registeredEmails = new Set();
const submittedEmails = new Set();
const mpRows = await sb(`miracleplus_contacts?select=email_canonical,application_progress&limit=10000`);
for (const r of mpRows) {
  if (!r.email_canonical) continue;
  if (allEmails.has(r.email_canonical)) {
    registeredEmails.add(r.email_canonical);
    if (r.application_progress) submittedEmails.add(r.email_canonical);
  }
}

// Brief_lookups
const wechatEmails = new Set();
const briefRows = await sb(`brief_lookups?select=query&added_wechat=eq.true&limit=10000`);
for (const r of briefRows) {
  const q = (r.query ?? "").trim().toLowerCase();
  if (q && q.includes("@") && allEmails.has(q)) wechatEmails.add(q);
}

let bothWechatAndSubmitted = 0;
for (const e of submittedEmails) if (wechatEmails.has(e)) bothWechatAndSubmitted++;

console.log("Conversion matrix (last 90 days):");
console.log(`  totalEmailed              = ${totalEmailed}`);
console.log(`  registered                = ${registeredEmails.size}`);
console.log(`  submittedApplication      = ${submittedEmails.size}`);
console.log(`  wechatAdded               = ${wechatEmails.size}`);
console.log(`  bothWechatAndSubmitted    = ${bothWechatAndSubmitted}`);

// ── 6. Diagnose mask ──────────────────────────────────────────────────
console.log("\n=== STEP 5: mask diagnosis ===");
let maskedSeen = 0;
let unmaskedSeen = 0;
for (const c of hits) {
  if (typeof c.email === "string") {
    if (c.email.replace(/\*/g, "").length === 0) maskedSeen++;
    else if (c.email.includes("@")) unmaskedSeen++;
  }
}
console.log(`In this MP response: ${maskedSeen} masked emails, ${unmaskedSeen} unmasked.`);
if (totalEmailed > 0 && registeredEmails.size === 0 && maskedSeen > 0) {
  console.log("⚠ STAGING MASK CONFIRMED: MP returns email='******', so cross-table");
  console.log("  joins find 0 overlap even when contacts exist. Switching MP_API_BASE");
  console.log("  to the prod URL (and using a prod token) should populate the matrix.");
}

console.log("\n=== DONE ===");
