// 100-worker parallel quality audit on ALL ready drafts in prod.
// Checks 11 rules; classifies HARD (should not ship) vs SOFT (flag).
//
// Usage: node scripts/_audit-drafts-v2.mjs

import { readFileSync, writeFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
);

const SENTENCE_END_RE = /[。．\.!！?？]["'』」）)]?\s*$/;
const LLM_META_PATTERNS = [
  /Let's check/i, /Let's refine/i, /Let me/i, /Looking at/i,
  /Step \d+:/i, /\(\d+\s*chars?\)/i, /fourth part/i, /Three-part structure/i,
  /I must output/i, /raw text, no/i, /->\s*Correct/, /->\s*Under/,
  /option\s+a:/i, /option\s+b:/i,
];
const PROMPT_INSTRUCTION_LEAK_PATTERNS = [
  /推断作者下一步/, /严禁[:：]/, /标题超.*改成/,
  /\[X方向\]|\[Y方法\]|\[Z问题\]|\[作者可能想做的事\]/,
  /注意[:：]\s*[1-9]\./,
  /逗号是标点符号/,
  /三段论/,
  /markdown\/引号/,
];

function extractIntro(html) {
  if (!html) return null;
  const parts = html.split(/<br\s*\/?>\s*<br\s*\/?>/i);
  if (parts.length < 2) return null;
  return parts[1].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim();
}

function checkDraft(d) {
  const html = d.draft_html || "";
  const subject = d.draft_subject || "";
  const introSnap = d.draft_intro_output || null;
  const intro = introSnap || extractIntro(html);
  const issues = [];
  const stripped = html.replace(/<[^>]+>/g, " ");

  if (intro && !SENTENCE_END_RE.test(intro.trim())) issues.push({ key: "intro_truncated", severity: "HARD" });
  if (/\\u[0-9a-f]{4}/.test(html)) issues.push({ key: "json_unicode_leak", severity: "HARD" });
  if (/\["[^"]+",\s*"[^"]+"\]/.test(stripped)) issues.push({ key: "fragment_brackets", severity: "HARD" });
  for (const re of LLM_META_PATTERNS) {
    if (re.test(stripped)) { issues.push({ key: "llm_meta_leak", severity: "HARD" }); break; }
  }
  for (const re of PROMPT_INSTRUCTION_LEAK_PATTERNS) {
    if (re.test(stripped)) { issues.push({ key: "prompt_instructions_leak", severity: "HARD" }); break; }
  }
  if (!subject.trim()) issues.push({ key: "empty_subject", severity: "HARD" });
  if (!html.trim()) issues.push({ key: "empty_body", severity: "HARD" });
  if (html && !/[一-龥A-Za-z]{1,30}你好[，,]/.test(html.slice(0, 500))) issues.push({ key: "greeting_missing", severity: "HARD" });
  if (html && !/奇绩创坛/.test(html)) issues.push({ key: "signature_missing", severity: "HARD" });
  if (/\{\{REP_NAME\}\}|\{\{REP_WECHAT\}\}|\{\{CLOSING_NAME\}\}/.test(html)) issues.push({ key: "placeholder_leak", severity: "SOFT" });
  if (intro && intro.trim().length < 40) issues.push({ key: "abnormally_short_intro", severity: "SOFT" });
  if (intro && intro.trim().length > 300) issues.push({ key: "abnormally_long_intro", severity: "SOFT" });

  return issues;
}

console.log("fetching all ready leads...");
const all = [];
let cursor = 0;
while (cursor < 10000) {
  const { data } = await sb.from("pipeline_leads")
    .select("id, author_email, draft_subject, draft_html, draft_intro_output, draft_model, assigned_rep_id")
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .range(cursor, cursor + 999);
  if (!data || data.length === 0) break;
  all.push(...data);
  if (data.length < 1000) break;
  cursor += 1000;
}
console.log(`got ${all.length} ready drafts to audit with 100 workers\n`);

const t0 = Date.now();
let pos = 0;
const issueCount = { HARD: {}, SOFT: {} };
const findings = {};
const leadsWithHard = new Set();
const leadsWithAnyIssue = new Set();
function nextIdx() { return pos++; }

async function worker() {
  while (true) {
    const i = nextIdx();
    if (i >= all.length) return;
    const d = all[i];
    const issues = checkDraft(d);
    for (const { key, severity } of issues) {
      issueCount[severity][key] = (issueCount[severity][key] ?? 0) + 1;
      if (severity === "HARD") leadsWithHard.add(d.id);
      leadsWithAnyIssue.add(d.id);
      if (!findings[key]) findings[key] = [];
      if (findings[key].length < 30) {
        findings[key].push({
          id: d.id.slice(0, 8),
          email: d.author_email,
          model: d.draft_model,
          intro_end: (d.draft_intro_output || "").trim().slice(-120),
        });
      }
    }
  }
}

await Promise.all(Array.from({ length: 100 }, () => worker()));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const cleanCount = all.length - leadsWithAnyIssue.size;
const softOnlyCount = leadsWithAnyIssue.size - leadsWithHard.size;
console.log(`audited in ${elapsed}s\n`);
console.log(`=== Summary ===`);
console.log(`  total ready:        ${all.length}`);
console.log(`  CLEAN (0 issues):   ${cleanCount} (${(cleanCount * 100 / all.length).toFixed(1)}%)`);
console.log(`  SOFT-only:          ${softOnlyCount} (${(softOnlyCount * 100 / all.length).toFixed(1)}%) — ship but flag`);
console.log(`  HARD (should NOT ship): ${leadsWithHard.size} (${(leadsWithHard.size * 100 / all.length).toFixed(1)}%)`);
console.log(``);
console.log(`=== HARD issues ===`);
for (const [iss, count] of Object.entries(issueCount.HARD).sort(([, a], [, b]) => b - a)) {
  console.log(`  ${iss.padEnd(28)} ${count} (${(count * 100 / all.length).toFixed(1)}%)`);
}
console.log(`\n=== SOFT issues ===`);
for (const [iss, count] of Object.entries(issueCount.SOFT).sort(([, a], [, b]) => b - a)) {
  console.log(`  ${iss.padEnd(28)} ${count} (${(count * 100 / all.length).toFixed(1)}%)`);
}

writeFileSync("/tmp/draft-audit.json", JSON.stringify({
  audited_at: new Date().toISOString(),
  total: all.length,
  cleanCount,
  softOnlyCount,
  hardCount: leadsWithHard.size,
  issueCount,
  findings,
  hardLeadIds: Array.from(leadsWithHard),
}, null, 2));
console.log(`\nwrote /tmp/draft-audit.json (${leadsWithHard.size} HARD lead IDs preserved)`);
