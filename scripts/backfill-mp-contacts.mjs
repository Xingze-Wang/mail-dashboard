// One-shot backfill: for every distinct REACHABLE recipient in `emails`
// since the dawn of time, ask MP's CRM "do you have this person?" and
// upsert into miracleplus_contacts.
//
// This is the long-running version of /api/cron/sync-miracleplus-contacts
// — same syncContactByEmail primitive, but unbounded lookback. Run
// locally (not as a Vercel route) since runtime is ~5 min at 200ms
// rate-limit pacing across 1409 distinct emails.
//
// After running, getMpConversionMatrix({ since: backfill_window })
// will see every match MP has, not just the last 7 days.
//
// Usage: node scripts/backfill-mp-contacts.mjs

import { readFileSync } from "node:fs";

const envFile = readFileSync(".env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_BASE = (process.env.MP_API_BASE ?? "").replace(/\/+$/, "");
const MP_TOKEN = process.env.MP_API_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env"); process.exit(2); }
if (!MP_BASE || !MP_TOKEN) { console.error("Missing MP env"); process.exit(2); }

const REACHABLE = ["delivered", "clicked", "sent", "replied", "opened"];
const RATE_LIMIT_MS = 200;
const TIMEOUT_MS = 15_000;

// ── Step 1: Pull every distinct reachable recipient ──────────────────
console.log("[1/3] pulling distinct recipients from emails table...");
const all = new Set();
let cursor = 0;
const PAGE = 1000;
while (cursor < 100_000) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/emails?select=to&status=in.(${REACHABLE.join(",")})&order=created_at.asc&limit=${PAGE}&offset=${cursor}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0) break;
  for (const e of data) {
    if (e.to && typeof e.to === "string" && e.to.includes("@")) {
      all.add(e.to.trim().toLowerCase());
    }
  }
  if (data.length < PAGE) break;
  cursor += PAGE;
}
console.log(`    found ${all.size} distinct emails`);

// ── Step 2: For each email, ask MP + upsert ──────────────────────────
console.log(`[2/3] querying MP + upserting (ETA ~${Math.ceil(all.size * (RATE_LIMIT_MS + 150) / 60000)} min)...`);

const t0 = Date.now();
let checked = 0;
let matched = 0;
let upsertErrors = 0;
let apiErrors = 0;
const emails = Array.from(all);

async function mpSearch(email) {
  try {
    const res = await fetch(
      `${MP_BASE}/open_api/v1/contacts/search?q=${encodeURIComponent(email)}&per=10`,
      {
        headers: { Authorization: `Bearer ${MP_TOKEN}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) return { error: `http ${res.status}`, contacts: [] };
    const json = await res.json().catch(() => null);
    if (!json || json.code !== 0) return { error: `code ${json?.code}`, contacts: [] };
    return { contacts: json.data?.contacts ?? [] };
  } catch (err) {
    return { error: String(err).slice(0, 100), contacts: [] };
  }
}

function canonicalEmail(email) {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  if (trimmed.replace(/\*/g, "").length === 0) return null;
  return trimmed;
}

async function upsertContacts(contacts, queriedEmail) {
  const rows = contacts.map((c) => ({
    mp_id: c.id,
    email: typeof c.email === "string" ? c.email : null,
    email_canonical: canonicalEmail(typeof c.email === "string" ? c.email : null) ?? queriedEmail,
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
  }));
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/miracleplus_contacts?on_conflict=mp_id`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    return { error: `${res.status} ${body.slice(0, 200)}` };
  }
  return {};
}

for (const email of emails) {
  const { contacts, error: apiErr } = await mpSearch(email);
  checked++;
  if (apiErr) {
    apiErrors++;
  } else if (contacts.length > 0) {
    matched++;
    const { error: upErr } = await upsertContacts(contacts, email);
    if (upErr) {
      upsertErrors++;
      if (upsertErrors < 5) console.error(`  upsert err for ${email}: ${upErr}`);
    }
  }
  if (checked % 50 === 0) {
    const pct = ((checked / emails.length) * 100).toFixed(0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`    ${checked}/${emails.length} (${pct}%) — matched=${matched} apiErr=${apiErrors} upErr=${upsertErrors} elapsed=${elapsed}s\n`);
  }
  if (checked < emails.length) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
}

const ms = Date.now() - t0;
console.log(`\n[3/3] DONE. checked=${checked} matched=${matched} apiErr=${apiErrors} upErr=${upsertErrors} elapsed=${(ms/1000).toFixed(0)}s`);

// ── Step 3: Final mirror count + conversion preview ──────────────────
const r2 = await fetch(
  `${SUPABASE_URL}/rest/v1/miracleplus_contacts?select=mp_id&limit=1`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "count=exact" } },
);
const totalMirror = r2.headers.get("content-range")?.split("/")[1];
console.log(`\nminus mirror rows now: ${totalMirror}`);

// Breakdown of progress states
const r3 = await fetch(
  `${SUPABASE_URL}/rest/v1/miracleplus_contacts?select=application_progress,application_stage,applications_number,submitted_at`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
);
const allMp = await r3.json();
const buckets = { unregistered: 0, registered: 0, submitted: 0 };
for (const c of allMp) {
  const prog = (c.application_progress ?? "").toLowerCase();
  const isSubmitted = prog.includes("submitted") || (c.applications_number ?? 0) > 0 || !!c.submitted_at;
  if (isSubmitted) buckets.submitted++;
  else if (prog.includes("未注册") || prog === "" || !c.application_progress) buckets.unregistered++;
  else buckets.registered++;
}
console.log("\nbreakdown:", buckets);
