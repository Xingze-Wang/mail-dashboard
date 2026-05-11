// Audit the 365-day contact dedup. Three checks, each emits any
// violation it finds (silence = pass).
//
// 1. SAME EMAIL twice in `emails.to` within 365 days → person-firewall bypass
// 2. SAME arxiv_id twice in `emails.paper_arxiv_id` within 365 days → paper bypass
// 3. SAME thread_id with >1 distinct `emails.to` (different recipients on
//    same lead — usually means a co-author dup the paper-firewall missed)
//
// Plus: a sanity check on `email_contact_history` to make sure it's
// being written when the guard runs (helps catch silent log failures).
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
const cutoff = new Date(Date.now() - HORIZON_MS).toISOString();

// Drain past Supabase's 1000-row REST cap.
async function drainAll(builder) {
  const all = [];
  let from = 0; const batch = 1000;
  while (true) {
    const { data, error } = await builder().range(from, from + batch - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < batch) break;
    from += batch;
  }
  return all;
}

console.log(`\n=== 365-day dedup audit (cutoff: ${cutoff.slice(0,10)}) ===\n`);

// ─── 1. emails.to duplicates ──────────────────────────────────────────
console.log("[1] emails.to — same recipient twice within 365d?");
const emails = await drainAll(() =>
  sb.from("emails")
    .select("id, to, created_at, status, paper_arxiv_id, thread_id")
    .gte("created_at", cutoff)
);
console.log(`    pulled ${emails.length} rows`);

const byRecipient = new Map();
for (const e of emails) {
  const to = (e.to || "").toLowerCase().trim();
  if (!to) continue;
  if (!byRecipient.has(to)) byRecipient.set(to, []);
  byRecipient.get(to).push(e);
}
const recipientDups = [...byRecipient.entries()].filter(([, rows]) => rows.length > 1);
console.log(`    unique recipients: ${byRecipient.size}`);
console.log(`    recipients with >1 send: ${recipientDups.length}`);
if (recipientDups.length > 0) {
  console.log("    ▸ TOP 10 by send count:");
  recipientDups
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .forEach(([to, rows]) => {
      const dates = rows.map(r => r.created_at.slice(0, 10)).sort();
      const statuses = rows.map(r => r.status).join(",");
      console.log(`      ${to}  ×${rows.length}  [${dates[0]} .. ${dates[dates.length-1]}]  status=${statuses}`);
    });
}

// ─── 2. emails.paper_arxiv_id duplicates ──────────────────────────────
console.log("\n[2] emails.paper_arxiv_id — same paper twice within 365d?");
const byArxiv = new Map();
for (const e of emails) {
  const aid = (e.paper_arxiv_id || "").trim();
  if (!aid) continue;
  if (!byArxiv.has(aid)) byArxiv.set(aid, []);
  byArxiv.get(aid).push(e);
}
const paperDups = [...byArxiv.entries()].filter(([, rows]) => {
  // Same arxiv_id to same recipient is a duplicate but already caught
  // by (1); the paper-firewall is about same arxiv_id to DIFFERENT recipients.
  const recipients = new Set(rows.map(r => (r.to || "").toLowerCase().trim()));
  return recipients.size > 1;
});
console.log(`    papers with sends to multiple distinct recipients: ${paperDups.length}`);
if (paperDups.length > 0) {
  console.log("    ▸ TOP 10:");
  paperDups
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .forEach(([aid, rows]) => {
      const recips = [...new Set(rows.map(r => r.to))].slice(0, 5);
      console.log(`      ${aid}  ×${rows.length} sends to ${recips.length} distinct  e.g. ${recips.slice(0,3).join(", ")}`);
    });
}

// ─── 3. persons.emails[] — does the person-firewall actually merge? ─────
console.log("\n[3] persons.emails[] — person with multiple emails, any contacted twice?");
const persons = await drainAll(() =>
  sb.from("persons").select("id, real_name, emails, last_outreach_at")
);
console.log(`    pulled ${persons.length} persons`);

const recentRecipientsLower = new Set([...byRecipient.keys()]);
let crossEmailBypass = 0;
const examples = [];
for (const p of persons) {
  if (!Array.isArray(p.emails) || p.emails.length < 2) continue;
  const lower = p.emails.map(e => (e || "").toLowerCase().trim()).filter(Boolean);
  const hits = lower.filter(e => recentRecipientsLower.has(e));
  if (hits.length >= 2) {
    crossEmailBypass++;
    if (examples.length < 10) examples.push({ name: p.real_name, hits, last: p.last_outreach_at });
  }
}
console.log(`    persons contacted via ≥2 of their emails within 365d: ${crossEmailBypass}`);
if (examples.length > 0) {
  console.log("    ▸ examples — these would be person-firewall bypasses if guard relied only on emails.to:");
  for (const ex of examples) {
    console.log(`      ${ex.name || "(unnamed)"}  hits=[${ex.hits.join(", ")}]  last_outreach_at=${ex.last ?? "—"}`);
  }
}

// ─── 4. is email_contact_history being written? ──────────────────────
console.log("\n[4] email_contact_history — is the dedup log being populated?");
const { count: histCount } = await sb
  .from("email_contact_history")
  .select("id", { count: "exact", head: true })
  .gte("contacted_at", cutoff);
const { count: emailsRecent } = await sb
  .from("emails")
  .select("id", { count: "exact", head: true })
  .gte("created_at", cutoff)
  .in("status", ["delivered", "clicked", "bounced", "complained"]);
console.log(`    email_contact_history rows in 365d:     ${histCount}`);
console.log(`    emails rows in 365d (reached recipient): ${emailsRecent}`);
const ratio = emailsRecent > 0 ? (histCount / emailsRecent) : 0;
console.log(`    ratio: ${(ratio * 100).toFixed(0)}%  (low ratio → log not being written on every send)`);

// ─── 5. anyone in DNC also got sent recently? (worst-case bug) ──────
console.log("\n[5] DNC violations — anyone with outreach_status='do_not_contact' got an email?");
const dnc = await drainAll(() =>
  sb.from("persons").select("id, real_name, emails").eq("outreach_status", "do_not_contact")
);
console.log(`    DNC persons: ${dnc.length}`);
let dncBreached = 0;
for (const p of dnc) {
  if (!Array.isArray(p.emails)) continue;
  for (const e of p.emails) {
    if (recentRecipientsLower.has((e || "").toLowerCase().trim())) {
      console.log(`    ⚠ DNC BREACH: ${p.real_name || p.id} via ${e}`);
      dncBreached++;
    }
  }
}
if (dncBreached === 0) console.log("    none ✓");

console.log("\n=== audit done ===");
