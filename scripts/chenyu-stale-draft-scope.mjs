/**
 * Scope the chenyu-in-draft_html bug: how many leads still have stale
 * Chenyu-named drafts, and how many already went out the door?
 *
 * Splits by status because the action differs:
 *   - status=sent: email already gone, can't fix outbound but can clean
 *     audit trail (emails.html already records what was sent)
 *   - status=ready / drafted: still in queue, MUST fix before send
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("=== Scope of Chenyu-in-draft_html ===\n");
const { data, count } = await sb
  .from("pipeline_leads")
  .select("id, status, assigned_rep_id, created_at, draft_subject", { count: "exact" })
  .ilike("draft_html", "%Chenyu%")
  .order("created_at", { ascending: false });
console.log(`Total leads with 'Chenyu' in draft_html: ${count}\n`);

const byStatus = {};
const byRep = {};
for (const l of data ?? []) {
  byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
  byRep[l.assigned_rep_id] = (byRep[l.assigned_rep_id] ?? 0) + 1;
}
console.log("By status:");
for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s.padEnd(15)} ${n}`);
console.log("\nBy assigned_rep_id:");
for (const [r, n] of Object.entries(byRep)) console.log(`  rep_id=${r.padEnd(4)} ${n}`);

console.log("\n=== Emails (already sent) referencing Chenyu, last 30d ===");
const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
const { count: emailCount } = await sb
  .from("emails")
  .select("id", { count: "exact", head: true })
  .ilike("html", "%Chenyu%")
  .gte("created_at", since30);
console.log(`emails with Chenyu in body (last 30d): ${emailCount}`);
