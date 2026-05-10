import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

// Replicate the segment-funnels.ts call literally — it does NOT paginate leadsRaw
const { data: leadsRaw, error } = await sb
  .from("pipeline_leads")
  .select("author_email, school_tier, lead_tier, h_index, citation_count, matched_directions, assigned_rep_id");
console.log("leadsRaw length (no range):", leadsRaw?.length, "err:", error?.message ?? "ok");

// With explicit range
const allLeads = [];
let cursor = 0;
while (true) {
  const { data, error: e2 } = await sb
    .from("pipeline_leads")
    .select("author_email, school_tier, lead_tier, h_index, citation_count, matched_directions, assigned_rep_id")
    .range(cursor, cursor + 999);
  if (e2 || !data || data.length === 0) break;
  allLeads.push(...data);
  if (data.length < 1000) break;
  cursor += 1000;
}
console.log("with pagination, total leads:", allLeads.length);

// Now redo the match
import { createClient as cc2 } from "@supabase/supabase-js"; // already imported
const since90d = new Date(Date.now() - 90*86_400_000).toISOString();

const allEmails = [];
let c2 = 0;
while (true) {
  const { data, error: e3 } = await sb.from("emails").select("to, status").gte("created_at", since90d).order("created_at", {ascending: false}).range(c2, c2+999);
  if (e3 || !data || data.length === 0) break;
  allEmails.push(...data);
  if (data.length < 1000) break;
  c2 += 1000;
}
const featByEmail = new Map();
for (const l of allLeads) {
  const em = (l.author_email ?? "").toLowerCase().trim();
  if (em) featByEmail.set(em, { h: l.h_index });
}

const REACHABLE = new Set(["sent","delivered","clicked","complained","bounced","replied"]);
const DELIVERED = new Set(["delivered","clicked","complained"]);
const byRecipient = new Map();
for (const e of allEmails) {
  if (!e.to || !e.status || !REACHABLE.has(e.status)) continue;
  const em = e.to.toLowerCase().trim();
  if (!em.includes("@")) continue;
  const cur = byRecipient.get(em) ?? { delivered: false, clicked: false };
  if (DELIVERED.has(e.status)) cur.delivered = true;
  if (e.status === "clicked") cur.clicked = true;
  byRecipient.set(em, cur);
}

let orphans = 0, matched = 0;
const buckets = {">=50":0,"20-49":0,"10-19":0,"5-9":0,"<5":0,"unknown":0};
for (const [em, s] of byRecipient.entries()) {
  if (!s.delivered) continue;
  if (!featByEmail.has(em)) { orphans++; continue; }
  matched++;
  const h = featByEmail.get(em).h;
  if (h == null) buckets.unknown++;
  else if (h >= 50) buckets[">=50"]++;
  else if (h >= 20) buckets["20-49"]++;
  else if (h >= 10) buckets["10-19"]++;
  else if (h >= 5) buckets["5-9"]++;
  else buckets["<5"]++;
}
console.log("With FULL leads (paginated):");
console.log("  delivered orphans (no lead):", orphans);
console.log("  delivered matched to lead:", matched);
console.log("  h_index buckets (matched):", buckets);
