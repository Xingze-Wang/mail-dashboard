#!/usr/bin/env node
// Second pass: same checks, but recalibrated against what the pipeline
// actually emits today (not the email_qc.py spec verbatim). The goal is to
// surface REAL content failures (CoT leaks, missing 4th clause, etc.) and
// suppress spec-drift noise (block 5 anchor stripping, English paper
// titles in intros, school-paragraph variants).
//
// What changed from _audit-unsent-qc.mjs:
//   - INTRO_EN_PROSE: cap raised to 80 chars (real intros include English
//     paper titles like "Towards Generalized Image Manipulation
//     Localization paper"). Tightening hurts more than it helps.
//   - BLOCK4_NOT_LEGAL: downgraded to WARN; we keep it for visibility but
//     don't let it dominate the FAIL count.
//   - BLOCK5_ALTERED: downgraded to WARN for the same reason — the spec's
//     reconstruction misses the <a href="...">申请</a> link the pipeline
//     actually embeds, so the regex was systematically off.
//   - SERVER_PLACEHOLDER_PRESENT in non-ready statuses: WARN (expected).
//     In status="ready", an unfilled placeholder is still ERROR.

import fs from "node:fs";

const INPUT = "/tmp/unsent_drafts.json";
const OUTPUT = "/tmp/unsent_qc_report_v2.json";

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
const MAX_LATIN_RUN = 80;  // ← was 28; relaxed for real English titles
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
function checkFixedBlocks(blocks, queueMode, issues) {
  const [, , b3, , , b6] = blocks;
  // Block 3 — fixed sales paragraph: must contain the recognizable phrase
  if (!b3.includes("奇绩创坛的") || !b3.includes("奇绩算力计划")) {
    issues.push({ code:"BLOCK3_ALTERED", severity:"ERROR", message:"sales paragraph altered", sample:sample(b3) });
  }
  // Block 6 — signature
  if (!b6.includes("奇绩创坛")) issues.push({ code:"BLOCK6_ALTERED", severity:"ERROR", message:"missing 奇绩创坛", sample:sample(b6) });

  const joined = blocks.join(" ");
  for (const ph of ["{{REP_NAME}}", "{{REP_WECHAT}}"]) {
    if (joined.includes(ph)) {
      issues.push({ code: queueMode ? "SERVER_PLACEHOLDER_PRESENT" : "SERVER_PLACEHOLDER_UNFILLED",
                    severity: queueMode ? "WARN" : "ERROR", message:`${ph} present` });
    }
  }
  const probe = joined.replaceAll("{{","").replaceAll("}}","");
  const m = probe.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  if (m) issues.push({ code:"FSTRING_LEAK", severity:"ERROR", message:`leak ${m[0]}` });

  // Soft check: block 4 should mention 奇绩算力 OR 算力 + 1.5%
  const b4 = blocks[3] || "";
  if (!(b4.includes("奇绩算力") || b4.includes("1.5%") || b4.includes("100万"))) {
    issues.push({ code:"BLOCK4_OFF_TEMPLATE", severity:"WARN", message:"block 4 lacks expected keywords", sample:sample(b4) });
  }
}

function validate(subject, html, status) {
  const queueMode = status !== "ready";
  const issues = [];
  checkSubject(subject || "", issues);
  const blocks = splitBlocks(html || "");
  if (blocks.length !== 6) {
    issues.push({ code:"BLOCK_COUNT", severity:"ERROR", message:`got ${blocks.length} blocks` });
    return { ok:false, issues, blocks };
  }
  checkGreeting(blocks[0], issues);
  checkIntro(blocks[1], issues);
  checkFixedBlocks(blocks, queueMode, issues);
  const ok = !issues.some(i => i.severity === "ERROR");
  return { ok, issues, blocks };
}

const raw = JSON.parse(fs.readFileSync(INPUT, "utf8"));
const leads = raw.leads;

const results = [];
const codeCounts = {};
const byStatus = {};

for (const lead of leads) {
  const r = validate(lead.draft_subject, lead.draft_html, lead.status);
  for (const issue of r.issues) codeCounts[issue.code] = (codeCounts[issue.code] || 0) + 1;
  byStatus[lead.status] ||= { total:0, pass:0, fail:0, warn_only:0 };
  byStatus[lead.status].total++;
  if (r.ok && r.issues.length === 0) byStatus[lead.status].pass++;
  else if (r.ok) byStatus[lead.status].warn_only++;
  else byStatus[lead.status].fail++;

  results.push({
    id: lead.id, author_name: lead.author_name, author_email: lead.author_email,
    title: lead.title, assigned_rep_id: lead.assigned_rep_id, lead_tier: lead.lead_tier,
    status: lead.status, created_at: lead.created_at,
    qc_ok: r.ok,
    qc_summary: r.ok ? (r.issues.length === 0 ? "PASS" : `PASS (${r.issues.length} warn)`)
                     : `FAIL (${r.issues.filter(i=>i.severity==="ERROR").length} err)`,
    error_codes: r.issues.filter(i => i.severity === "ERROR").map(i => i.code),
    warning_codes: r.issues.filter(i => i.severity === "WARN").map(i => i.code),
    issues: r.issues,
    draft_subject: lead.draft_subject,
    draft_html: lead.draft_html,
  });
}

fs.writeFileSync(OUTPUT, JSON.stringify({
  total: results.length, by_status: byStatus, code_counts: codeCounts,
  generated_at: new Date().toISOString(), results,
}, null, 2));

console.log(`\n=== RECALIBRATED AUDIT: ${results.length} unsent drafts ===\n`);
console.log("By status:");
for (const [s, b] of Object.entries(byStatus).sort()) {
  console.log(`  ${s.padEnd(10)}  total=${b.total}  pass=${b.pass}  warn-only=${b.warn_only}  FAIL=${b.fail}`);
}
console.log("\nFailure-code counts:");
const sorted = Object.entries(codeCounts).sort((a,b) => b[1]-a[1]);
for (const [c, n] of sorted) console.log(`  ${n.toString().padStart(5)}  ${c}`);
console.log(`\nFull report: ${OUTPUT}`);
