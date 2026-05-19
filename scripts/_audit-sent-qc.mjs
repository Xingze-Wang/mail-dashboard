#!/usr/bin/env node
// Same recalibrated QC as _audit-unsent-qc2.mjs, but consumes /tmp/sent_emails.json.
// Sent rows have a slightly different shape (toEmail/html/repId vs
// author_email/draft_html/assigned_rep_id), so we normalize first, then call
// the same validate() logic. Author name + paper title are enriched from
// /tmp/unsent_drafts.json's lead set when there's a paperArxivId match;
// otherwise we leave them blank — they're nice-to-have, not gate-relevant.

import fs from "node:fs";

const SENT_INPUT = "/tmp/sent_emails.json";
const UNSENT_INPUT = "/tmp/unsent_drafts.json";  // for enrichment only
const OUTPUT = "/tmp/sent_qc_report.json";

// ---- QC constants & functions (same as _audit-unsent-qc2.mjs; copied to keep
// this script standalone) ----
const SUBJECT_PREFIX = "Invitation to Apply - ";
const SUBJECT_SUFFIX = "的潜在算力支持机会";
const FALLBACK_INTRO = "最近在跟踪 AI 算力相关的研究方向时，读到了您团队的工作，其中的方法很有启发。";

const COT_LEAK_MARKERS = [
  "<think>", "</think>", "好的，", "好的。", "当然，", "以下是",
  "首先，我", "让我", "我将", "我会为", "思考：", "分析：", "草稿：",
  "Option A", "Option B", "Here is", "Here's", "Sure,", "Certainly", "Okay,",
  "I cannot", "I can't", "I'm unable", "As an AI",
  "Wait,", "Hmm,", "Actually,", "Let's", "let me",
  "one sentence", "I need to", "I should", "make sure",
  "根据论文写", "写一句", "个性化开头", "必须以句号", "中途截断",
  "重新写", "重写", "Rewrite", "Revised", "Final answer", "最终答案",
  "正确例子", "错误例子", "->", "→ \"",
];
const BANNED_INTRO_SYMBOLS = ['"', "“", "”", "*", "//", "%", "$", "`",
  "#", "@", "&", "=", "+", "\\", "<", ">", "|", "~"];

const INTRO_MIN_CHARS = 24;
const INTRO_MAX_CHARS = 220;
const INTRO_MIN_SEGMENTS = 3;
const INTRO_MAX_SEGMENTS = 6;
const INTRO_MAX_SEGMENT_CHARS = 55;
const INTRO_QZHONG_CLAUSE_MAX = 45;
const MAX_LATIN_RUN = 80;
const LATIN_RUN_RE = new RegExp(`[A-Za-z][A-Za-z ,'\\-]{${MAX_LATIN_RUN - 1},}`);

function decode(t) {
  return t.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&nbsp;/g," ");
}
function splitBlocks(html) {
  if (!html) return [];
  let t = html.replace(/<br\s*\/?>/gi, "<br>");
  t = t.replace(/<\/?(?:html|head|body|meta)[^>]*>/gi, "");
  const parts = t.split(/(?:<br>\s*){2,}/);
  const out = [];
  for (const p of parts) {
    const txt = decode(p.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (txt) out.push(txt);
  }
  return out;
}
function looksChinese(s) { return /[一-鿿]/.test(s); }
function sample(s, n=80) { s=(s||"").replace(/\s+/g," ").trim(); return s.length>n ? s.slice(0,n)+"…" : s; }

function checkSubject(s, issues) {
  s = (s || "").trim();
  if (s.length < 10) issues.push({ code:"SUBJECT_TOO_SHORT", severity:"ERROR", message:`${s.length} chars`, sample:s.slice(0,40) });
  if (!s.startsWith(SUBJECT_PREFIX)) issues.push({ code:"SUBJECT_PREFIX", severity:"ERROR", message:"missing prefix", sample:s.slice(0,50) });
  if (!s.endsWith(SUBJECT_SUFFIX)) issues.push({ code:"SUBJECT_SUFFIX", severity:"WARN", message:"missing suffix", sample:s.slice(-40) });
  const probe = s.replaceAll("{{","").replaceAll("}}","");
  const m = probe.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  if (m) issues.push({ code:"SUBJECT_FSTRING_LEAK", severity:"ERROR", message:`leak ${m[0]}`, sample:m[0] });
}
function checkGreeting(b, issues) {
  if (!/^.{0,40}你好，$/.test(b)) issues.push({ code:"GREETING_SHAPE", severity:"ERROR", message:"not '<name>你好，'", sample:sample(b) });
}
function checkIntro(intro, issues) {
  intro = intro.trim();
  if (!intro) { issues.push({ code:"INTRO_MISSING", severity:"ERROR", message:"empty" }); return; }
  if (intro === FALLBACK_INTRO) { issues.push({ code:"INTRO_IS_FALLBACK", severity:"WARN", message:"fallback" }); return; }
  const L = [...intro].length;
  if (L < INTRO_MIN_CHARS) issues.push({ code:"INTRO_TOO_SHORT", severity:"ERROR", message:`${L} chars`, sample:sample(intro) });
  if (L > INTRO_MAX_CHARS) issues.push({ code:"INTRO_TOO_LONG", severity:"ERROR", message:`${L} chars`, sample:sample(intro) });
  if (!looksChinese(intro)) issues.push({ code:"INTRO_NOT_CHINESE", severity:"ERROR", message:"no Chinese", sample:sample(intro) });
  for (const sym of BANNED_INTRO_SYMBOLS) {
    if (intro.includes(sym)) { issues.push({ code:"INTRO_BANNED_SYMBOL", severity:"ERROR", message:`contains ${JSON.stringify(sym)}`, sample:sample(intro) }); break; }
  }
  const low = intro.toLowerCase();
  for (const m of COT_LEAK_MARKERS) {
    if (low.includes(m.toLowerCase())) { issues.push({ code:"INTRO_COT_LEAK", severity:"ERROR", message:`marker ${JSON.stringify(m)}`, sample:sample(intro) }); break; }
  }
  if (/[A-Za-z][A-Za-z ,']{2,}\?/.test(intro))
    issues.push({ code:"INTRO_EN_QUESTION", severity:"ERROR", message:"English question", sample:sample(intro) });
  if (intro.includes("->") || intro.includes("→"))
    issues.push({ code:"INTRO_ARROW_MAPPING", severity:"ERROR", message:"arrow", sample:sample(intro) });
  if (!intro.includes("最近在")) issues.push({ code:"INTRO_NO_OPENER", severity:"ERROR", message:"missing 最近在", sample:sample(intro) });
  if (!intro.includes("读到")) issues.push({ code:"INTRO_NO_PAPER_REF", severity:"ERROR", message:"missing 读到", sample:sample(intro) });
  if (!(intro.includes("如果能有更多算力") || intro.includes("如果有更多算力") || intro.includes("更多算力支持"))) {
    issues.push({ code:"INTRO_NO_FOURTH_CLAUSE", severity:"ERROR", message:"missing 4th 算力 clause", sample:sample(intro) });
  }
  const commaN = (intro.match(/[，,]/g) || []).length;
  if (commaN < 2) issues.push({ code:"INTRO_NOT_FOUR_SEGMENT", severity:"ERROR", message:`${commaN} commas`, sample:sample(intro) });
  const trimmed = intro.replace(/[。！？!?\.]+$/, "");
  const segments = trimmed.split(/[，,]/).map(s => s.trim()).filter(Boolean);
  if (segments.length < INTRO_MIN_SEGMENTS) issues.push({ code:"INTRO_TOO_FEW_SEGMENTS", severity:"ERROR", message:`${segments.length} seg`, sample:sample(intro) });
  if (segments.length > INTRO_MAX_SEGMENTS) issues.push({ code:"INTRO_TOO_MANY_SEGMENTS", severity:"ERROR", message:`${segments.length} seg`, sample:sample(intro) });
  for (let i = 0; i < segments.length; i++) {
    const segLen = [...segments[i]].length;
    if (segLen > INTRO_MAX_SEGMENT_CHARS) { issues.push({ code:"INTRO_SEGMENT_TOO_LONG", severity:"ERROR", message:`clause ${i+1}: ${segLen}c`, sample:sample(segments[i]) }); break; }
  }
  for (const seg of segments) {
    if (seg.includes("其中")) {
      const segLen = [...seg].length;
      if (segLen > INTRO_QZHONG_CLAUSE_MAX)
        issues.push({ code:"INTRO_METHOD_CLAUSE_TOO_LONG", severity:"ERROR", message:`${segLen}c`, sample:sample(seg) });
      break;
    }
  }
  const last = intro.trimEnd().slice(-1);
  if (!"。！？!?.".includes(last))
    issues.push({ code:"INTRO_TRUNCATED", severity:"ERROR", message:`ends on ${JSON.stringify(last)}`, sample:sample(intro.slice(-40)) });
  const m = intro.match(LATIN_RUN_RE);
  if (m) issues.push({ code:"INTRO_EN_PROSE", severity:"ERROR", message:`${m[0].length}-char EN run`, sample:sample(m[0]) });
}
function checkFixedBlocks(blocks, issues) {
  // Sent emails always have REP / WECHAT filled (validated server-side at send).
  // But if a literal {{REP_NAME}} survived the send, it's catastrophic.
  const [, , b3, , , b6] = blocks;
  if (!b3.includes("奇绩创坛的") || !b3.includes("奇绩算力计划"))
    issues.push({ code:"BLOCK3_ALTERED", severity:"ERROR", message:"sales paragraph altered", sample:sample(b3) });
  if (!b6.includes("奇绩创坛")) issues.push({ code:"BLOCK6_ALTERED", severity:"ERROR", message:"missing 奇绩创坛", sample:sample(b6) });
  const joined = blocks.join(" ");
  for (const ph of ["{{REP_NAME}}", "{{REP_WECHAT}}"]) {
    if (joined.includes(ph)) issues.push({ code:"SERVER_PLACEHOLDER_UNFILLED", severity:"ERROR", message:`${ph} reached SENT email` });
  }
  const probe = joined.replaceAll("{{","").replaceAll("}}","");
  const m = probe.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  if (m) issues.push({ code:"FSTRING_LEAK", severity:"ERROR", message:`leak ${m[0]}` });
  const b4 = blocks[3] || "";
  if (!(b4.includes("奇绩算力") || b4.includes("1.5%") || b4.includes("100万"))) {
    issues.push({ code:"BLOCK4_OFF_TEMPLATE", severity:"WARN", message:"block 4 lacks expected keywords", sample:sample(b4) });
  }
}

function validate(subject, html) {
  const issues = [];
  checkSubject(subject || "", issues);
  const blocks = splitBlocks(html || "");
  if (blocks.length !== 6) {
    issues.push({ code:"BLOCK_COUNT", severity:"ERROR", message:`got ${blocks.length} blocks` });
    return { ok:false, issues, blocks };
  }
  checkGreeting(blocks[0], issues);
  checkIntro(blocks[1], issues);
  checkFixedBlocks(blocks, issues);
  const ok = !issues.some(i => i.severity === "ERROR");
  return { ok, issues, blocks };
}

// ---- enrichment: map paperArxivId -> title from the unsent dump ----
const unsent = JSON.parse(fs.readFileSync(UNSENT_INPUT, "utf8"));
const arxivToMeta = new Map();
const emailToMeta = new Map();
for (const lead of unsent.leads) {
  if (lead.paper_arxiv_id) arxivToMeta.set(lead.paper_arxiv_id, { author_name: lead.author_name, title: lead.title });
  if (lead.author_email) emailToMeta.set(lead.author_email.toLowerCase(), { author_name: lead.author_name, title: lead.title });
}

// ---- run ----
const sent = JSON.parse(fs.readFileSync(SENT_INPUT, "utf8"));
const repNames = {1:"Leo", 2:"Yujie", 3:"Ethan", 4:"Chenyu", 5:"Xingze", 10:"李金阳"};

const results = [];
const codeCounts = {};
const byRep = {};
const byStatus = {};

for (const e of sent.emails) {
  const meta = (e.paperArxivId && arxivToMeta.get(e.paperArxivId))
            || (e.toEmail && emailToMeta.get(e.toEmail.toLowerCase()))
            || {};
  const r = validate(e.subject, e.html);
  for (const issue of r.issues) codeCounts[issue.code] = (codeCounts[issue.code] || 0) + 1;
  const repKey = repNames[e.repId] || `rep_${e.repId}`;
  byRep[repKey] ||= { total: 0, pass: 0, warn_only: 0, fail: 0 };
  byRep[repKey].total++;
  if (r.ok && r.issues.length === 0) byRep[repKey].pass++;
  else if (r.ok) byRep[repKey].warn_only++;
  else byRep[repKey].fail++;

  byStatus[e.status] ||= { total: 0, pass: 0, warn_only: 0, fail: 0 };
  byStatus[e.status].total++;
  if (r.ok && r.issues.length === 0) byStatus[e.status].pass++;
  else if (r.ok) byStatus[e.status].warn_only++;
  else byStatus[e.status].fail++;

  results.push({
    id: e.id,
    to_email: e.toEmail,
    author_name: meta.author_name || "",
    title: meta.title || "",
    subject: e.subject,
    html: e.html,
    rep_id: e.repId,
    rep_name: repKey,
    status: e.status,
    created_at: e.createdAt,
    template_id: e.templateId,
    paper_arxiv_id: e.paperArxivId,
    qc_ok: r.ok,
    qc_summary: r.ok ? (r.issues.length === 0 ? "PASS" : `PASS (${r.issues.length} warn)`) : `FAIL (${r.issues.filter(i=>i.severity==="ERROR").length} err)`,
    error_codes: r.issues.filter(i => i.severity === "ERROR").map(i => i.code),
    warning_codes: r.issues.filter(i => i.severity === "WARN").map(i => i.code),
    issues: r.issues,
  });
}

fs.writeFileSync(OUTPUT, JSON.stringify({
  total: results.length,
  by_rep: byRep,
  by_status: byStatus,
  code_counts: codeCounts,
  oldest: sent.oldestCreatedAt,
  newest: sent.newestCreatedAt,
  generated_at: new Date().toISOString(),
  results,
}, null, 2));

console.log(`\n=== SENT-EMAIL QC: ${results.length} emails (${sent.oldestCreatedAt?.slice(0,10)} → ${sent.newestCreatedAt?.slice(0,10)}) ===\n`);
console.log("By rep:");
for (const [r, b] of Object.entries(byRep).sort((a,b) => b[1].total - a[1].total)) {
  const pct = ((b.fail / b.total) * 100).toFixed(1);
  console.log(`  ${r.padEnd(10)}  total=${b.total.toString().padStart(4)}  pass=${b.pass.toString().padStart(4)}  warn=${b.warn_only.toString().padStart(3)}  FAIL=${b.fail.toString().padStart(3)} (${pct}%)`);
}
console.log("\nBy delivery status:");
for (const [s, b] of Object.entries(byStatus).sort((a,b) => b[1].total - a[1].total)) {
  const pct = ((b.fail / b.total) * 100).toFixed(1);
  console.log(`  ${s.padEnd(12)}  total=${b.total.toString().padStart(4)}  FAIL=${b.fail.toString().padStart(3)} (${pct}%)`);
}
console.log("\nFailure-code counts:");
for (const [c, n] of Object.entries(codeCounts).sort((a,b) => b[1]-a[1])) console.log(`  ${n.toString().padStart(4)}  ${c}`);
console.log(`\nFull report: ${OUTPUT}`);
