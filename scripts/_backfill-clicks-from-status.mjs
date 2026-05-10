import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Drain all clicked emails
const all = [];
let from = 0;
while (true) {
  const { data, error } = await sb.from("emails").select("id, thread_id, updated_at").eq("status", "clicked").range(from, from + 999);
  if (error) { console.error(error.message); break; }
  if (!data?.length) break;
  all.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}
console.log("clicked emails:", all.length);

// Group by thread_id (one lead can have multiple emails)
const byThread = new Map();
for (const e of all) {
  if (!e.thread_id) continue;
  const cur = byThread.get(e.thread_id) ?? { count: 0, last: null };
  cur.count++;
  if (e.updated_at && (!cur.last || e.updated_at > cur.last)) cur.last = e.updated_at;
  byThread.set(e.thread_id, cur);
}
console.log("threads with clicks:", byThread.size);

// Update pipeline_leads
let n = 0, miss = 0;
for (const [threadId, agg] of byThread) {
  const { data: leadRow } = await sb.from("pipeline_leads").select("id").eq("thread_id", threadId).maybeSingle();
  if (!leadRow) { miss++; continue; }
  const upd = { click_count: agg.count };
  if (agg.last) upd.last_click_at = agg.last;
  const { error } = await sb.from("pipeline_leads").update(upd).eq("id", leadRow.id);
  if (error) console.error("err", leadRow.id, error.message);
  else n++;
}
console.log("updated leads:", n, "| no-lead-for-thread:", miss);
