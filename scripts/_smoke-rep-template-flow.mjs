import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1"; // don't push to real Lark during test

const { sendRepTemplateProposalCard } = await import("/Users/xingzewang/Desktop/mail/src/lib/rep-template-card.ts");

const r = await sendRepTemplateProposalCard({
  template_id: "00000000-0000-0000-0000-000000000000",
  template_name: "[smoke] test template",
  rep_id: 2,
  proposed_reason: "test smoke",
  diff_summary: "+ adds a line about deadlines",
});
console.log("sendRepTemplateProposalCard returned:", r);
if (r !== null && typeof r !== "string") {
  console.error("expected null or string message_id");
  process.exit(1);
}
console.log("✓ send branch smoke");

// ── approve path ──────────────────────────────────────────────────────
const { createClient } = await import("@supabase/supabase-js");
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const smokeName = `[smoke] approve-flow ${Date.now()}`;
const { data: insRow, error: insErr } = await s
  .from("email_templates")
  .insert({
    name: smokeName,
    rep_id: 2,
    status: "proposal",
    active: false,
    proposed_by: "smoke",
    proposed_to_rep_at: new Date().toISOString(),
    subject_format: "[smoke] subject",
    intro_prompt: "smoke",
    greeting_format: "Hi {{NAME}}",
    rep_intro_format: "smoke",
    school_pitch_format: "smoke",
    cta_signoff_format: "smoke",
  })
  .select("id")
  .single();
if (insErr || !insRow) { console.error("insert failed:", insErr); process.exit(1); }
const tid = insRow.id;

const { processRepTemplateCardAction } = await import("/Users/xingzewang/Desktop/mail/src/lib/rep-template-card.ts");

const { data: rep } = await s.from("sales_reps").select("lark_open_id").eq("id", 2).maybeSingle();
const fakeEvent = {
  event: {
    operator: { open_id: rep.lark_open_id },
    action: { value: { template_rep_action: "approve", template_id: tid } },
  },
};
const out = await processRepTemplateCardAction(fakeEvent);
console.log("approve handler returned:", out);

const { data: after } = await s.from("email_templates").select("rep_approved_at").eq("id", tid).single();
if (!after.rep_approved_at) { console.error("❌ rep_approved_at not set"); process.exit(1); }
console.log("✓ rep_approved_at set:", after.rep_approved_at);

await s.from("email_templates").delete().eq("id", tid);
