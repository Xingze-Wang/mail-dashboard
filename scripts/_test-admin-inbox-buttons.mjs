// Smoke test for the redesigned admin_inbox card.
//
// What it does:
//   1. Insert 2 admin_inbox rows — one kind=request, one kind=idea
//   2. Call sendAdminInboxCard for each → confirms button set branches on kind
//   3. Simulate a card click (skill/yes) via processAdminInboxCardAction
//      → confirms helper_learnings rows land with the right kind values
//
// Verifies the surface-parity rule: same code path whether button was
// clicked in Lark or in /admin/inbox web UI.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";  // don't pollute admin's Lark DM

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { sendAdminInboxCard, processAdminInboxCardAction } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts"
);

// Admin's open_id — needed for the processAdminInboxCardAction permission check
const { data: admin } = await supabase
  .from("sales_reps")
  .select("lark_open_id")
  .eq("id", 5)
  .maybeSingle();
const adminOpenId = admin?.lark_open_id;
if (!adminOpenId) {
  console.error("Admin (rep 5) has no lark_open_id — can't run smoke test");
  process.exit(1);
}

const now = Date.now();
const dedupSuffix = `-smoke-${now}`;

console.log("\n[1/4] Inserting two admin_inbox rows (request + idea)…");
const { data: rows } = await supabase
  .from("admin_inbox")
  .insert([
    {
      kind: "request",
      headline: "SMOKE: please confirm the bench reset",
      body: "Yes/No test — should show two buttons only.",
      source_rep_id: 5,
      status: "new",
      dedup_hash: "req" + dedupSuffix,
    },
    {
      kind: "idea",
      headline: "SMOKE: when rep says 'tier-1 only', filter school_tier_band ≤ 2",
      body: "Skill/Memory/Both/Neither test — should show 4 buttons.",
      source_rep_id: 5,
      status: "new",
      dedup_hash: "idea" + dedupSuffix,
    },
  ])
  .select("id, kind, headline");
console.log("  inserted:", rows?.length, "rows");
if (!rows || rows.length !== 2) {
  console.error("Insert failed:", rows);
  process.exit(1);
}

const requestRow = rows.find((r) => r.kind === "request");
const ideaRow = rows.find((r) => r.kind === "idea");

console.log("\n[2/4] Pushing cards…");
const msgReq = await sendAdminInboxCard({
  inbox_id: requestRow.id,
  kind: "request",
  headline: requestRow.headline,
  body: "Yes/No test — should show two buttons only.",
  source_rep_id: 5,
  source_rep_name: "Xingze (smoke)",
});
console.log("  request card pushed →", msgReq);
const msgIdea = await sendAdminInboxCard({
  inbox_id: ideaRow.id,
  kind: "idea",
  headline: ideaRow.headline,
  body: "Skill/Memory/Both/Neither test — should show 4 buttons.",
  source_rep_id: 5,
  source_rep_name: "Xingze (smoke)",
});
console.log("  idea card pushed →", msgIdea);

console.log("\n[3/4] Simulating click: action=yes on request row…");
const yesResult = await processAdminInboxCardAction({
  event: {
    operator: { open_id: adminOpenId },
    action: { value: { admin_inbox_action: "yes", inbox_id: requestRow.id } },
  },
});
console.log("  result:", yesResult);

console.log("\n[4/4] Simulating click: action=both on idea row…");
const bothResult = await processAdminInboxCardAction({
  event: {
    operator: { open_id: adminOpenId },
    action: { value: { admin_inbox_action: "both", inbox_id: ideaRow.id } },
  },
});
console.log("  result:", bothResult);

// Verify the side effects
console.log("\nVerifying side effects…");
const { data: reqAfter } = await supabase
  .from("admin_inbox")
  .select("status, acted_at")
  .eq("id", requestRow.id)
  .maybeSingle();
console.log("  request row status:", reqAfter?.status);

const { data: ideaAfter } = await supabase
  .from("admin_inbox")
  .select("status, evidence")
  .eq("id", ideaRow.id)
  .maybeSingle();
console.log("  idea row status:", ideaAfter?.status);
const learningIds = ideaAfter?.evidence?.promoted_to_learning_ids ?? [];
console.log("  promoted learning_ids:", learningIds);
if (learningIds.length > 0) {
  const { data: learnings } = await supabase
    .from("helper_learnings")
    .select("id, kind, body")
    .in("id", learningIds);
  for (const l of learnings ?? []) {
    console.log("    learning kind=" + l.kind + " body=" + l.body.slice(0, 60));
  }
}

console.log("\n✅ Smoke complete. Check Lark for two cards (one Yes/No, one Skill/Memory/Both/Neither).");
