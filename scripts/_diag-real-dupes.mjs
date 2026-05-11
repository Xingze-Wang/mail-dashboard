// Re-compute the true duplicate count, excluding replies.
// A reply is identified by subject starting with "Re:" or "回复".
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const cutoff = new Date(Date.now() - 365*24*60*60*1000).toISOString();

// Pull every outbound emails row in 365d with full context.
const { data: all } = await sb.from("emails")
  .select("id, created_at, to, subject, in_reply_to, paper_arxiv_id, thread_id, actor_rep_id")
  .gte("created_at", cutoff)
  .order("created_at");

console.log(`Total emails rows in 365d: ${all?.length}`);

// Bucket by lowercased recipient.
const byTo = new Map();
for (const r of all ?? []) {
  const k = (r.to ?? "").toLowerCase().trim();
  if (!k) continue;
  if (!byTo.has(k)) byTo.set(k, []);
  byTo.get(k).push(r);
}

const truly = [];
for (const [to, rows] of byTo) {
  if (rows.length < 2) continue;
  // Filter out replies: any row where subject starts with Re:/回复, OR
  // in_reply_to is non-null, IS a reply — not an outreach send.
  const outreach = rows.filter(r => {
    const s = (r.subject ?? "").trim();
    if (s.startsWith("Re:") || s.startsWith("回复") || s.startsWith("回覆")) return false;
    if (r.in_reply_to) return false;
    return true;
  });
  if (outreach.length >= 2) truly.push({ to, outreach, replies: rows.length - outreach.length });
}

console.log(`\nRecipients with ≥2 OUTREACH sends (excluding replies): ${truly.length}`);
for (const t of truly) {
  console.log(`\n▸ ${t.to}  (${t.outreach.length} outreach, ${t.replies} replies)`);
  for (const r of t.outreach) {
    console.log(`   ${r.created_at}  paper=${r.paper_arxiv_id ?? "—"}  thread=${(r.thread_id ?? "").slice(0,18)}  subj="${(r.subject ?? "").slice(0,55)}"`);
  }
}

// Also: how many pairs had paper_arxiv_id NULL on at least one of them?
let nullArxivCases = 0;
let sameArxiv = 0;
let diffArxiv = 0;
for (const t of truly) {
  const ax = t.outreach.map(r => r.paper_arxiv_id);
  if (ax.some(x => !x)) nullArxivCases++;
  const populated = ax.filter(Boolean);
  if (populated.length >= 2 && new Set(populated).size === 1) sameArxiv++;
  if (populated.length >= 2 && new Set(populated).size > 1) diffArxiv++;
}
console.log(`\n--- pattern breakdown ---`);
console.log(`  pairs with at least 1 NULL paper_arxiv_id: ${nullArxivCases}`);
console.log(`  pairs with SAME paper_arxiv_id (true repeat of same paper): ${sameArxiv}`);
console.log(`  pairs with DIFFERENT paper_arxiv_id (different papers, same author): ${diffArxiv}`);
