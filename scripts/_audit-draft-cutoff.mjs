// Scan recent drafts for cut-off problems.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Use pagination since the .not() filter combined with limits seemed off
// Paginate to bypass the 1000-row Supabase REST cap
const all = [];
let offset = 0;
const pageSize = 1000;
while (true) {
  const { data, error } = await s
    .from("pipeline_leads")
    .select("id, status, draft_html, draft_subject, draft_intro_output, author_name, title, created_at, draft_model")
    .gte("created_at", "2026-05-14")
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);
  if (error) { console.error("err:", error.message); break; }
  if (!data || data.length === 0) break;
  all.push(...data);
  if (data.length < pageSize) break;
  offset += pageSize;
}
const data = all;
console.log("rows fetched:", data.length);
const withDraft = (data || []).filter((l) => l.draft_html && l.draft_html.length > 0);
console.log("with draft:", withDraft.length);

const lens = withDraft.map((l) => l.draft_html.length).sort((a, b) => a - b);
if (lens.length === 0) {
  console.log("no drafts found in this window");
  process.exit(0);
}
console.log("\nlen distribution:");
console.log("  min:", lens[0], "p10:", lens[Math.floor(lens.length * 0.1)], "median:", lens[Math.floor(lens.length / 2)], "max:", lens[lens.length - 1]);
console.log("  < 800:", lens.filter((n) => n < 800).length);
console.log("  < 1200:", lens.filter((n) => n < 1200).length);
console.log("  < 1500:", lens.filter((n) => n < 1500).length);

// Heuristic: cut-off endings — no closing </body> or </html>, ends mid-sentence,
// ends with a backtick / opening bracket / ellipsis etc.
function looksCutOff(html) {
  const tail = html.slice(-150).trim();
  const lastChar = tail.slice(-1);
  // Properly-ended emails should end with </body>, </p>, </div>, or punctuation
  if (/<\/(body|html|table|div|p)>$/i.test(tail)) return false;
  if (/[.!?。！？>]\s*$/.test(tail)) return false;
  // Ends with a comma, opening bracket, mid-word, etc → cut off
  return true;
}

const cutOff = withDraft.filter((l) => looksCutOff(l.draft_html));
console.log("\nlooks cut off (heuristic):", cutOff.length, "of", withDraft.length);
console.log("\n5 most-suspicious drafts:");
for (const l of cutOff.slice(0, 5)) {
  console.log("---");
  console.log("  id:", l.id, "| status:", l.status, "| len:", l.draft_html.length, "| model:", l.draft_model);
  console.log("  subject:", (l.draft_subject || "").slice(0, 80));
  console.log("  author:", l.author_name, "| paper:", (l.title || "").slice(0, 50));
  console.log("  tail (last 350 chars):");
  console.log("  ...«" + l.draft_html.slice(-350).replace(/\s+/g, " ") + "»");
  console.log("  intro_output (last 200):");
  console.log("  ...«" + ((l.draft_intro_output || "").slice(-200).replace(/\s+/g, " ")) + "»");
}

// Also: pull 3 shortest non-null drafts
console.log("\n\n3 shortest drafts overall:");
const shortest = [...withDraft].sort((a, b) => a.draft_html.length - b.draft_html.length).slice(0, 3);
for (const l of shortest) {
  console.log("---");
  console.log("  id:", l.id, "| len:", l.draft_html.length);
  console.log("  full draft_html:");
  console.log("  ", l.draft_html);
}
