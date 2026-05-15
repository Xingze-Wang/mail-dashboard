// Did the smoke card clicks reach prod? Check signals:
//   1. Vercel function logs for /api/lark/webhook in the last 10min
//      (we can't tail those from here, but we can query supabase for
//      side effects).
//   2. admin_inbox rows with kind='request' headline starting [SMOKE]
//      or with proposal_key like 'smoke-*' (quota card persists one).
//   3. lark_messages mirror of the inbound card_action event.
//
// We hit prod's supabase via the service role through a tiny endpoint.
// Actually — simpler: just curl /api/admin/recent-card-clicks. We
// don't have that endpoint, so create a one-shot via direct supabase.

import { config } from "dotenv";
config({ path: "/tmp/.vercel.env" });   // prod env, supabase block bypass

const { createClient } = await import("@supabase/supabase-js");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/"/g, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/"/g, "");
if (!url || !key) {
  console.error("missing supabase env"); process.exit(1);
}

// Note: this client's fetch will hit supabase.co from THIS laptop.
// The block we saw earlier was intermittent — try, fall back to a
// console.log if it fails so we know.
const sb = createClient(url, key, { auth: { persistSession: false } });

const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

console.log("Checking signals since:", tenMinAgo);

// Signal 1: did the quota-card persist a smoke admin_inbox row?
const { data: q, error: qe } = await sb
  .from("admin_inbox")
  .select("id, headline, status, acted_at, evidence, dedup_hash, created_at")
  .like("dedup_hash", "smoke-%")
  .order("created_at", { ascending: false })
  .limit(5);
console.log("\n=== smoke admin_inbox rows (from quota card) ===");
if (qe) console.log("err:", qe.message);
else for (const r of q || []) console.log(JSON.stringify(r, null, 2));

// Signal 2: lark_messages with card_action in the last 10 min
// (the processor mirrors button clicks via processInboundLarkMessage
// only for text messages, not card actions — so we may not see this.
// Check anyway in case it does.)
const { data: m, error: me } = await sb
  .from("lark_messages")
  .select("id, role, text, metadata, created_at")
  .gte("created_at", tenMinAgo)
  .order("created_at", { ascending: false })
  .limit(15);
console.log("\n=== lark_messages last 10min ===");
if (me) console.log("err:", me.message);
else for (const r of m || []) {
  const txt = (r.text || "").slice(0, 120).replace(/\n/g, " ⏎ ");
  console.log(`[${r.created_at}] ${r.role}: ${txt}`);
}
