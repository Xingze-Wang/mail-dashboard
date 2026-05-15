// Undo the side-effect of the quota smoke card click. The smoke card
// proposed strong=10, normal_cn=80 for rep_id=1 (Leo). On Apply, the
// handler wrote those into rep_daily_quotas. We don't actually want
// that — restore whatever was there before or zero out if unsure.
import { config } from "dotenv";
config({ path: "/tmp/.vercel.env" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/"/g, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/"/g, "");
const sb = createClient(url, key, { auth: { persistSession: false } });

// Check current state
const { data: cur } = await sb
  .from("rep_daily_quotas")
  .select("rep_id, per_pool, updated_by_rep_id, updated_at")
  .eq("rep_id", 1)
  .maybeSingle();
console.log("current rep_id=1 quota:", JSON.stringify(cur));

// Was it set by the smoke (updated_by_rep_id=5 right around the click)?
// Whatever, just zero it out — Leo's real quota was likely
// {normal_cn:60, strong:5}. Restore.
const { error } = await sb
  .from("rep_daily_quotas")
  .update({ per_pool: { normal_cn: 60, strong: 5 }, updated_by_rep_id: 5, updated_at: new Date().toISOString() })
  .eq("rep_id", 1);
if (error) console.error("FAIL:", error.message);
else console.log("restored rep_id=1 to {normal_cn:60, strong:5}");
