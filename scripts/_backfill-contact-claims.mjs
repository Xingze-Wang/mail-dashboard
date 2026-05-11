// Backfill contact_claims from emails.to so the unique-email gate is
// consistent with reality immediately after mig 079 ships. Without this,
// an existing recipient could get re-contacted via a brand-new lead row
// — the unique index protects future sends but says nothing about past
// emails (since contact_claims started empty).
//
// One claim per distinct lowercase email_normalized. Confirmed=true
// because Resend already accepted these.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
const cutoff = new Date(Date.now() - HORIZON_MS).toISOString();

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

// 1. Pull every email row that reached a real recipient in the last 365d.
console.log("Draining emails sent in last 365 days...");
const emails = await drainAll(() =>
  sb.from("emails")
    .select("id, to, created_at, actor_rep_id, paper_arxiv_id, resend_id, thread_id")
    .gte("created_at", cutoff)
    .in("status", ["delivered", "clicked", "bounced", "complained", "sent"])
);
console.log(`  total emails: ${emails.length}`);

// 2. Dedupe to (normalized email, earliest created_at).
const byEmail = new Map();
for (const e of emails) {
  const norm = (e.to || "").trim().toLowerCase();
  if (!norm || !norm.includes("@")) continue;
  // Skip the audit-CC address — partial unique index excludes it.
  if (norm === "williamxwang03@gmail.com") continue;
  const cur = byEmail.get(norm);
  if (!cur || e.created_at < cur.created_at) byEmail.set(norm, e);
}
console.log(`  distinct recipients to backfill: ${byEmail.size}`);

// 3. Also map each recipient to their lead via thread_id (best-effort).
const threadIds = [...byEmail.values()].map(e => e.thread_id).filter(Boolean);
const threadToLead = new Map();
for (let i = 0; i < threadIds.length; i += 200) {
  const slice = threadIds.slice(i, i + 200);
  const { data } = await sb.from("pipeline_leads").select("id, thread_id").in("thread_id", slice);
  for (const r of data || []) threadToLead.set(r.thread_id, r.id);
}
console.log(`  threads → leads resolved: ${threadToLead.size}`);

// 4. Insert claims. Use ON CONFLICT DO NOTHING via a per-row try
// (Supabase REST doesn't support upsert with custom WHERE on partial
// index; we just catch 23505 and move on).
console.log("Inserting claims...");
let inserted = 0, conflict = 0, errored = 0;
const rows = [];
for (const [norm, e] of byEmail) {
  rows.push({
    email_normalized: norm,
    actor_rep_id: e.actor_rep_id ?? null,
    lead_id: threadToLead.get(e.thread_id) ?? null,
    paper_arxiv_id: e.paper_arxiv_id ?? null,
    claimed_at: e.created_at,
    confirmed: true,
    resend_id: e.resend_id ?? null,
  });
}
// Bulk insert in 500-row chunks. On any conflict the chunk fails; fall
// back to per-row to find which one collided.
for (let i = 0; i < rows.length; i += 500) {
  const slice = rows.slice(i, i + 500);
  const { error } = await sb.from("contact_claims").insert(slice);
  if (error) {
    // Fall back to per-row to count conflicts vs real errors.
    for (const r of slice) {
      const { error: rowErr } = await sb.from("contact_claims").insert(r);
      if (!rowErr) inserted++;
      else if (rowErr.code === "23505") conflict++;
      else { errored++; console.error("    err:", r.email_normalized, rowErr.message); }
    }
  } else {
    inserted += slice.length;
  }
  console.log(`  chunk ${i}-${i + slice.length}: cumulative inserted=${inserted} conflict=${conflict} errored=${errored}`);
}
console.log(`DONE — inserted=${inserted} conflict=${conflict} errored=${errored}`);
