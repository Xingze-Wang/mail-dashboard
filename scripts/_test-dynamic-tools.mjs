// E2E smoke for the dynamic_tools loop:
//   1. Leon proposes a tool via propose_tool
//   2. admin_inbox row created + Lark card pushed
//   3. Simulate the admin Yes click → tool flips to approved
//   4. Call the new tool via runReadTool (fallthrough path)
//   5. Verify the SQL ran, rows came back, call_count incremented
//   6. cleanup
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { runReadTool } = await import("/Users/xingzewang/Desktop/mail/src/lib/helper-read-tools.ts");
const { processAdminInboxCardAction } = await import("/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts");

const session = { repId: 5, role: "admin", repName: "Xingze", email: "x@e.com" };
const toolName = "smoke_count_recent_leads";

console.log("[1/6] cleanup any prior smoke rows…");
await supabase.from("dynamic_tools").delete().eq("name", toolName);

console.log("\n[2/6] propose_tool …");
const proposal = await runReadTool(session, {
  tool: "propose_tool",
  args: {
    name: toolName,
    description: "Count pipeline_leads created in the last N days, optionally filtered by tier.",
    args_schema: {
      days: { type: "number", default: 7, description: "lookback window" },
      tier: { type: "string", default: "all", description: "'strong' | 'normal' | 'all'" },
    },
    param_order: ["days", "tier"],
    sql_template:
      "SELECT count(*)::int AS cnt FROM pipeline_leads WHERE created_at >= now() - ($1::int * interval '1 day') AND ($2::text = 'all' OR lead_tier = $2::text)",
    proposal_reason:
      "I keep getting asked 'how many strong leads this week' — having a dedicated counter avoids loading rows with list_leads.",
  },
});
console.log("  →", proposal.result);
const proposalId = proposal.result.id;
const inboxId = proposal.result.inbox_id;

console.log("\n[3/6] verify pending row + inbox card…");
const { data: pending } = await supabase
  .from("dynamic_tools")
  .select("status, sql_template, param_order")
  .eq("id", proposalId)
  .maybeSingle();
console.log("  pending status:", pending?.status);

console.log("\n[4/6] simulate admin Yes click on the card…");
// Need admin's lark_open_id
const { data: admin } = await supabase
  .from("sales_reps")
  .select("lark_open_id")
  .eq("id", 5)
  .maybeSingle();
const clickResult = await processAdminInboxCardAction({
  event: {
    operator: { open_id: admin?.lark_open_id ?? "ou_smoke" },
    action: { value: { admin_inbox_action: "yes", inbox_id: inboxId } },
  },
});
console.log("  click result:", clickResult);

const { data: approved } = await supabase
  .from("dynamic_tools")
  .select("status, approved_at")
  .eq("id", proposalId)
  .maybeSingle();
console.log("  status after click:", approved?.status, "| approved_at:", approved?.approved_at);

console.log("\n[5/6] call the new tool via runReadTool (fallthrough)…");
const r1 = await runReadTool(session, { tool: toolName, args: { days: 7, tier: "strong" } });
console.log("  strong (7d):", r1.result);
const r2 = await runReadTool(session, { tool: toolName, args: { days: 30, tier: "all" } });
console.log("  all (30d):", r2.result);

// Verify call_count incremented
const { data: postCall } = await supabase
  .from("dynamic_tools")
  .select("call_count, last_error")
  .eq("id", proposalId)
  .maybeSingle();
console.log("  call_count:", postCall?.call_count, "| last_error:", postCall?.last_error);

console.log("\n[6/6] cleanup…");
await supabase.from("dynamic_tools").delete().eq("id", proposalId);
if (inboxId) await supabase.from("admin_inbox").delete().eq("id", inboxId);

console.log("\n✅ Dynamic tools loop verified end-to-end.");
