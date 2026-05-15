// Fire a real template_proposal_card to admin's DM through the prod
// shared module. Verifies: tenant token works, admin open_id is set,
// card schema is accepted by Lark, message_id comes back.
import { config } from "dotenv";
config({ path: ".env.local" });

// Direct diagnostic: check each link in the chain so message_id=null
// becomes a specific cause, not a black box.
const { supabase } = await import("../src/lib/db.ts");
const { data: admin, error: aerr } = await supabase
  .from("sales_reps")
  .select("id, name, role, lark_open_id, active")
  .eq("id", 5)
  .maybeSingle();
console.log("admin row:", admin, "err:", aerr?.message);

const { getTenantAccessToken, pickBase } = await import("../src/lib/lark.ts");
const token = await getTenantAccessToken();
console.log("tenant token ok:", !!token, "base:", pickBase());

const { sendTemplateProposalCard } = await import("../src/lib/admin-approval-cards.ts");
const id = await sendTemplateProposalCard({
  template_id: "00000000-0000-0000-0000-000000000000",
  template_name: "[SMOKE TEST] template approval card",
  proposed_by: "smoke-test",
  proposed_reason:
    "If you see this card, the new admin-approval-card path is wired correctly. " +
    "The buttons WILL fire handlers but operate on a fake template_id, so 'Approve draft' will no-op silently (it updates 0 rows). Safe to click for end-to-end test.",
});
console.log("message_id:", id);
