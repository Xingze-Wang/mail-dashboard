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
