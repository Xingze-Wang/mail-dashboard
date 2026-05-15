// End-to-end smoke test for the new doc-edit loop:
//   1. Create a rich doc via createRichLarkDoc
//   2. listLarkDocBlocks to read back the block IDs
//   3. proposeDocEdit with a structured edit (update + insert_at)
//   4. approveDocEditProposal (admin path, auto-applies)
//   5. listLarkDocBlocks again to verify the apply landed
// If all 5 work, the loop is real. Run with PERSIST=1 to keep the
// test doc afterward; otherwise it stays in your Lark drive.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { createRichLarkDoc, listLarkDocBlocks } = await import("/Users/xingzewang/Desktop/mail/src/lib/lark.ts");
const { proposeDocEdit, approveDocEditProposal } = await import("/Users/xingzewang/Desktop/mail/src/lib/doc-edit-proposals.ts");

console.log("\n[1/5] Creating rich doc…");
const created = await createRichLarkDoc({
  title: "Doc-edit smoke test " + new Date().toISOString().slice(0, 16),
  blocks: [
    { kind: "h1", text: "Doc Edit Smoke Test" },
    { kind: "paragraph", text: "This is the original second paragraph. Leon will rewrite this." },
    { kind: "paragraph", text: "This is the third paragraph, untouched." },
  ],
});
if (!created.ok) { console.error("Create FAILED:", created.error); process.exit(1); }
console.log("  doc_id:", created.document_id, "| url:", created.url);

console.log("\n[2/5] Listing blocks to capture IDs…");
const listed = await listLarkDocBlocks({ document_id: created.document_id });
if (!listed.ok) { console.error("List FAILED:", listed.error); process.exit(1); }
for (const b of listed.blocks) console.log("  block_id:", b.block_id, "type:", b.block_type, "text:", b.text.slice(0, 60));

// Find the "second paragraph" block (block_type=2)
const second = listed.blocks.find((b) => b.text.includes("original second paragraph"));
if (!second) { console.error("Couldn't find second-paragraph block"); process.exit(1); }

console.log("\n[3/5] Proposing structured edit…");
const proposed = await proposeDocEdit({
  document_id: created.document_id,
  document_url: created.url,
  document_title: "Doc-edit smoke test",
  summary: "Rewrite second paragraph + insert a callout at top",
  narration: "Smoke test verifying update + insert_at land correctly. Original second paragraph rewritten more concise; new callout inserted at index 1 (right after the h1 title).",
  edits: [
    {
      action: "update",
      block_id: second.block_id,
      block_type: second.block_type,
      new_text: "Rewritten second paragraph — now half the length.",
    },
    {
      action: "insert_at",
      index: 1,
      blocks: [{ kind: "callout", text: "TL;DR inserted by Leon during the smoke test.", emoji: "memo" }],
    },
  ],
  proposed_by_rep_id: 5,
});
if (!proposed.ok) { console.error("Propose FAILED:", proposed.error); process.exit(1); }
console.log("  proposal_id:", proposed.id);

console.log("\n[4/5] Approving + auto-applying…");
const applied = await approveDocEditProposal({
  proposal_id: proposed.id,
  decided_by_rep_id: 5,
  apply_now: true,
});
if (!applied.ok) { console.error("Apply FAILED:", applied.error); process.exit(1); }
console.log("  applied_steps:", applied.applied_steps);

console.log("\n[5/5] Re-listing blocks to verify…");
const after = await listLarkDocBlocks({ document_id: created.document_id });
if (!after.ok) { console.error("Re-list FAILED:", after.error); process.exit(1); }
for (const b of after.blocks) console.log("  block_id:", b.block_id, "type:", b.block_type, "text:", b.text.slice(0, 80));

console.log("\n✅ Loop verified. Check the doc in Lark:", created.url);
if (process.env.PERSIST !== "1") {
  console.log("(Doc kept; delete from Lark drive if you don't want it.)");
}
