#!/usr/bin/env node
// One-off audit: run the proposed email_qc.py structural-lock checks against
// every unsent draft in /tmp/unsent_drafts.json and write a verdict per row.
//
// Faithful port of the user's email_qc.py spec, with two adjustments to
// reflect what the pipeline ACTUALLY emits (verified against real rows):
//   1. Intro uses English ASCII commas/periods, not Chinese 。，
//      -> punctuation checks accept BOTH.
//   2. Block 5 CTA wraps "申请" in an <a> tag and (in queue mode) the wechat
//      slot is still `{{REP_WECHAT}}`.
//      -> block-5 regex tolerates the anchor and either form.
// Every diagnostic carries a `severity` (ERROR / WARN) and a `code`.

import fs from "node:fs";
import path from "node:path";

const INPUT = "/tmp/unsent_drafts.json";
const OUTPUT = "/tmp/unsent_qc_report.json";

// ---- mirrored constants (from the spec) ----
const SUBJECT_PREFIX = "Invitation to Apply - ";
const SUBJECT_SUFFIX = "的潜在算力支持机会";

const BLOCK3_FIXED =
  "我是奇绩创坛的{REP}。针对具备高潜力的前沿科研项目，奇绩算力计划目前正" +
  "开放新一轮的申请，希望能通过免费算力，将科研的固定成本转变为边际成本，" +
  "助力前沿想法的快速验证。";

const TP_BASE_INFO = "单项目最高支持100万等值算力，相当于8卡H100连续跑15个月";
const TP_WECHAT_URL = "https://mp.weixin.qq.com/s/Ad7rKWbEc87Tq92DTfcI-g";

const BLOCK5_TEMPLATE_RE = new RegExp(
  "^如果[^（）()。]{1,30}对算力支持感兴趣，欢迎" +
  "(?:申请|<a [^>]*>申请</a>)" +
  "或加我微信交流（(?:\\{\\{REP_WECHAT\\}\\}|[^（）()]{1,40})）。$"
);

const SCHOOL_DATA = {
  "mit.edu": { name: "MIT", tier: 1, count: 6 },
  "stanford.edu": { name: "Stanford", tier: 1, count: 6 },
  "berkeley.edu": { name: "UC Berkeley", tier: 1, count: 3 },
  "cmu.edu": { name: "CMU", tier: 1, count: 1 },
  "harvard.edu": { name: "Harvard", tier: 1, count: 2 },
  "princeton.edu": { name: "Princeton", tier: 1, count: 1 },
  "caltech.edu": { name: "Caltech", tier: 1, count: 1 },
  "cam.ac.uk": { name: "Cambridge", tier: 1, count: 1 },
  "ox.ac.uk": { name: "Oxford", tier: 1, count: 2 },
  "ethz.ch": { name: "ETH Zurich", tier: 1, count: 1 },
  "tsinghua.edu.cn": { name: "清华", tier: 1, count: 24 },
  "pku.edu.cn": { name: "北大", tier: 1, count: 22 },
  // (full list lifted from spec; abbreviated here — see end of file for the
  // rest, appended programmatically to keep this readable)
};

// Programmatic extension so the constant block above stays scannable.
Object.assign(SCHOOL_DATA, {
  "gatech.edu": { name: "Georgia Tech", tier: 2, count: 11 },
  "cornell.edu": { name: "Cornell", tier: 2, count: 1 },
  "yale.edu": { name: "Yale", tier: 2, count: 1 },
  "upenn.edu": { name: "UPenn", tier: 2, count: 1 },
  "uchicago.edu": { name: "UChicago", tier: 2, count: 6 },
  "ucla.edu": { name: "UCLA", tier: 2, count: 2 },
  "ucsd.edu": { name: "UCSD", tier: 2, count: 2 },
  "illinois.edu": { name: "UIUC", tier: 2, count: 2 },
  "umich.edu": { name: "UMich", tier: 2, count: 2 },
  "nyu.edu": { name: "NYU", tier: 2, count: 1 },
  "jhu.edu": { name: "JHU", tier: 2, count: 1 },
  "duke.edu": { name: "Duke", tier: 2, count: 2 },
  "usc.edu": { name: "USC", tier: 2, count: 2 },
  "wisc.edu": { name: "UW-Madison", tier: 2, count: 1 },
  "ucl.ac.uk": { name: "UCL", tier: 2, count: 1 },
  "u-tokyo.ac.jp": { name: "东京大学", tier: 2, count: 1 },
  "nus.edu.sg": { name: "NUS", tier: 2, count: 3 },
  "ntu.edu.sg": { name: "NTU", tier: 2, count: 2 },
  "hku.hk": { name: "港大", tier: 2, count: 7 },
  "ust.hk": { name: "港科大", tier: 2, count: 6 },
  "hkust-gz.edu.cn": { name: "港科大(广州)", tier: 2, count: 6 },
  "cuhk.edu.hk": { name: "港中文", tier: 2, count: 2 },
  "cuhk.edu.cn": { name: "港中文(深圳)", tier: 2, count: 2 },
  "zju.edu.cn": { name: "浙大", tier: 2, count: 12 },
  "fudan.edu.cn": { name: "复旦", tier: 2, count: 1 },
  "sjtu.edu.cn": { name: "上交", tier: 2, count: 9 },
  "ustc.edu.cn": { name: "中科大", tier: 2, count: 7 },
  "nju.edu.cn": { name: "南大", tier: 2, count: 1 },
  "cas.cn": { name: "中科院", tier: 3, count: 8 },
  "ict.ac.cn": { name: "中科院", tier: 3, count: 8 },
  "buaa.edu.cn": { name: "北航", tier: 3, count: 6 },
  "bit.edu.cn": { name: "北理工", tier: 3, count: 3 },
  "bupt.edu.cn": { name: "北邮", tier: 3, count: 2 },
  "xjtu.edu.cn": { name: "西交", tier: 3, count: 1 },
  "hust.edu.cn": { name: "华科", tier: 3, count: 1 },
  "whu.edu.cn": { name: "武大", tier: 3, count: 3 },
  "seu.edu.cn": { name: "东南", tier: 3, count: 1 },
  "sdu.edu.cn": { name: "山大", tier: 3, count: 1 },
  "uestc.edu.cn": { name: "电子科大", tier: 3, count: 1 },
  "tongji.edu.cn": { name: "同济", tier: 3, count: 3 },
  "shanghaitech.edu.cn": { name: "上科大", tier: 3, count: 3 },
  "cityu.edu.hk": { name: "港城大", tier: 3, count: 3 },
  "uw.edu": { name: "UW Seattle", tier: 1, count: 1 },
  "washington.edu": { name: "UW Seattle", tier: 1, count: 1 },
  "utexas.edu": { name: "UT Austin", tier: 1, count: 1 },
  "umd.edu": { name: "UMD", tier: 2, count: 1 },
  "unc.edu": { name: "UNC", tier: 2, count: 1 },
  "northwestern.edu": { name: "Northwestern", tier: 2, count: 1 },
  "brown.edu": { name: "Brown", tier: 2, count: 1 },
  "rice.edu": { name: "Rice", tier: 2, count: 1 },
  "epfl.ch": { name: "EPFL", tier: 1, count: 1 },
  "tum.de": { name: "TU Munich", tier: 2, count: 1 },
  "imperial.ac.uk": { name: "Imperial", tier: 1, count: 1 },
  "ed.ac.uk": { name: "Edinburgh", tier: 2, count: 1 },
  "mpg.de": { name: "MPI", tier: 1, count: 1 },
  "inria.fr": { name: "Inria", tier: 2, count: 1 },
  "kaist.ac.kr": { name: "KAIST", tier: 1, count: 1 },
  "snu.ac.kr": { name: "SNU", tier: 1, count: 1 },
});

const FALLBACK_INTRO =
  "最近在跟踪 AI 算力相关的研究方向时，读到了您团队的工作，其中的方法很有启发。";

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
const MAX_LATIN_RUN = 28;
const LATIN_RUN_RE = new RegExp(`[A-Za-z][A-Za-z ,'\\-]{${MAX_LATIN_RUN - 1},}`);

// ---- helpers ----
function decode(t) {
  return t
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function splitBlocks(html) {
  if (!html) return [];
  let t = html.replace(/<br\s*\/?>/gi, "<br>");
  t = t.replace(/<\/?(?:html|head|body|meta)[^>]*>/gi, "");
  const parts = t.split(/(?:<br>\s*){2,}/);
  const out = [];
  for (const p of parts) {
    // strip tags but keep inner text (anchor labels survive)
    const txt = decode(p.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (txt) out.push(txt);
  }
  return out;
}

function looksChinese(s) {
  return /[一-鿿]/.test(s);
}

function getSchoolInfo(email) {
  if (!email || !email.includes("@")) return null;
  const domain = email.split("@").pop().toLowerCase();
  if (SCHOOL_DATA[domain]) return SCHOOL_DATA[domain];
  const parts = domain.split(".");
  for (let i = 0; i < parts.length; i++) {
    const partial = parts.slice(i).join(".");
    if (SCHOOL_DATA[partial]) return SCHOOL_DATA[partial];
  }
  return null;
}

function legalSchoolParagraphs(schoolInfo) {
  const baseInfo = TP_BASE_INFO;
  let schoolText;
  if (schoolInfo) {
    const { count, name, tier } = schoolInfo;
    if (count >= 20)      schoolText = `过去一年中，我们支持了超过20位来自${name}的researcher`;
    else if (count >= 15) schoolText = `过去一年中，我们支持了接近20位来自${name}的researcher`;
    else if (count >= 5)  schoolText = `过去一年中，我们支持了${count}位来自${name}的researcher`;
    else if (tier === 1)  schoolText = `过去一年中，我们支持了70+来自${name}、MIT、清华、北大等高校的项目`;
    else                  schoolText = `过去一年中，我们支持了70+来自MIT、清华、${name}等高校的项目`;
  } else {
    schoolText = "过去一年中，我们支持了70+前沿项目";
  }
  // both with-directions and without (directions are unknown at audit time)
  const noDir = `${schoolText}（${baseInfo}）。奇绩算力的特点是审核严格（通过率约1.5%），但额度较多，且完全免费（不占股，不要求署名，详见 ${TP_WECHAT_URL} ）。`;
  return new Set([noDir.replace(/\s+/g, " ").trim()]);
}

function blockMatchesFixed(block, fixedTemplate) {
  // Build a regex where {REP} becomes a bounded wildcard.
  const escaped = fixedTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + escaped.replace(/\\\{REP\\\}/g, "(?:\\{\\{REP_NAME\\}\\}|[^（）()。]{0,40})") + "$";
  return new RegExp(pattern).test(block);
}

function sample(s, n = 80) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---- checks ----
function checkSubject(subject, issues) {
  const s = (subject || "").trim();
  if (s.length < 10) issues.push({ code: "SUBJECT_TOO_SHORT", severity: "ERROR", message: `subject ${s.length} chars`, sample: s.slice(0, 40) });
  if (!s.startsWith(SUBJECT_PREFIX)) issues.push({ code: "SUBJECT_PREFIX", severity: "ERROR", message: `must start with '${SUBJECT_PREFIX}'`, sample: s.slice(0, 50) });
  if (!s.endsWith(SUBJECT_SUFFIX) && !s.rstrip?.(".").endsWith?.(SUBJECT_SUFFIX)) {
    if (!s.endsWith(SUBJECT_SUFFIX)) issues.push({ code: "SUBJECT_SUFFIX", severity: "WARN", message: `does not end with '${SUBJECT_SUFFIX}'`, sample: s.slice(-40) });
  }
  const probe = s.replaceAll("{{", "").replaceAll("}}", "");
  const m = probe.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  if (m) issues.push({ code: "SUBJECT_FSTRING_LEAK", severity: "ERROR", message: "unrendered placeholder", sample: m[0] });
}

function checkGreeting(block, issues) {
  if (!/^.{0,40}你好，$/.test(block)) {
    issues.push({ code: "GREETING_SHAPE", severity: "ERROR", message: "block 1 is not '<name>你好，'", sample: sample(block) });
  }
}

function checkIntro(intro, issues) {
  intro = intro.trim();
  if (!intro) { issues.push({ code: "INTRO_MISSING", severity: "ERROR", message: "block 2 empty" }); return; }
  if (intro === FALLBACK_INTRO) { issues.push({ code: "INTRO_IS_FALLBACK", severity: "WARN", message: "fallback intro (no personalization)" }); return; }

  const L = [...intro].length;  // char count, not byte
  if (L < INTRO_MIN_CHARS) issues.push({ code: "INTRO_TOO_SHORT", severity: "ERROR", message: `${L} chars`, sample: sample(intro) });
  if (L > INTRO_MAX_CHARS) issues.push({ code: "INTRO_TOO_LONG", severity: "ERROR", message: `${L} chars`, sample: sample(intro) });
  if (!looksChinese(intro)) issues.push({ code: "INTRO_NOT_CHINESE", severity: "ERROR", message: "no Chinese", sample: sample(intro) });

  for (const sym of BANNED_INTRO_SYMBOLS) {
    if (intro.includes(sym)) { issues.push({ code: "INTRO_BANNED_SYMBOL", severity: "ERROR", message: `contains ${JSON.stringify(sym)}`, sample: sample(intro) }); break; }
  }
  const low = intro.toLowerCase();
  for (const m of COT_LEAK_MARKERS) {
    if (low.includes(m.toLowerCase())) { issues.push({ code: "INTRO_COT_LEAK", severity: "ERROR", message: `marker ${JSON.stringify(m)}`, sample: sample(intro) }); break; }
  }
  if (/[A-Za-z][A-Za-z ,']{2,}\?/.test(intro))
    issues.push({ code: "INTRO_EN_QUESTION", severity: "ERROR", message: "English question (CoT leak)", sample: sample(intro) });
  if (intro.includes("->") || intro.includes("→"))
    issues.push({ code: "INTRO_ARROW_MAPPING", severity: "ERROR", message: "arrow operator (CoT leak)", sample: sample(intro) });

  // anchors
  if (!intro.includes("最近在")) issues.push({ code: "INTRO_NO_OPENER", severity: "ERROR", message: "missing 最近在 opener", sample: sample(intro) });
  if (!intro.includes("读到")) issues.push({ code: "INTRO_NO_PAPER_REF", severity: "ERROR", message: "missing 读到 paper ref", sample: sample(intro) });
  if (!(intro.includes("如果能有更多算力") || intro.includes("如果有更多算力") || intro.includes("更多算力支持"))) {
    issues.push({ code: "INTRO_NO_FOURTH_CLAUSE", severity: "ERROR", message: "missing 4th 算力 clause", sample: sample(intro) });
  }

  // punctuation: accept BOTH CN and EN forms (real drafts use English commas/periods)
  const commaN = (intro.match(/[，,]/g) || []).length;
  if (commaN < 2) issues.push({ code: "INTRO_NOT_FOUR_SEGMENT", severity: "ERROR", message: `${commaN} comma(s)`, sample: sample(intro) });

  // strip terminal punct, then split on , or ，
  const trimmed = intro.replace(/[。！？!?\.]+$/, "");
  const segments = trimmed.split(/[，,]/).map(s => s.trim()).filter(Boolean);
  if (segments.length < INTRO_MIN_SEGMENTS) issues.push({ code: "INTRO_TOO_FEW_SEGMENTS", severity: "ERROR", message: `${segments.length} seg`, sample: sample(intro) });
  if (segments.length > INTRO_MAX_SEGMENTS) issues.push({ code: "INTRO_TOO_MANY_SEGMENTS", severity: "ERROR", message: `${segments.length} seg`, sample: sample(intro) });
  for (let i = 0; i < segments.length; i++) {
    const segLen = [...segments[i]].length;
    if (segLen > INTRO_MAX_SEGMENT_CHARS) { issues.push({ code: "INTRO_SEGMENT_TOO_LONG", severity: "ERROR", message: `clause ${i + 1} is ${segLen} chars`, sample: sample(segments[i]) }); break; }
  }
  for (const seg of segments) {
    if (seg.includes("其中")) {
      const segLen = [...seg].length;
      if (segLen > INTRO_QZHONG_CLAUSE_MAX)
        issues.push({ code: "INTRO_METHOD_CLAUSE_TOO_LONG", severity: "ERROR", message: `其中… is ${segLen} chars`, sample: sample(seg) });
      break;
    }
  }

  // terminal punctuation: accept BOTH CN 。 and EN .
  const last = intro.trimEnd().slice(-1);
  if (!"。！？!?.".includes(last)) {
    issues.push({ code: "INTRO_TRUNCATED", severity: "ERROR", message: `ends on ${JSON.stringify(last)}`, sample: sample(intro.slice(-40)) });
  }

  // long English run -> refusal / CoT prose
  const m = intro.match(LATIN_RUN_RE);
  if (m) issues.push({ code: "INTRO_EN_PROSE", severity: "ERROR", message: `${m[0].length}-char English run`, sample: sample(m[0]) });
}

function checkFixedBlocks(blocks, toEmail, queueMode, issues) {
  const [, , b3, b4, b5, b6] = blocks;

  if (!blockMatchesFixed(b3, BLOCK3_FIXED))
    issues.push({ code: "BLOCK3_ALTERED", severity: "ERROR", message: "fixed sales paragraph altered", sample: sample(b3) });

  const schoolInfo = getSchoolInfo(toEmail || "");
  const legal = legalSchoolParagraphs(schoolInfo);
  if (!legal.has(b4)) {
    issues.push({ code: "BLOCK4_NOT_LEGAL", severity: "ERROR", message: "school paragraph not byte-identical to legal forms", sample: sample(b4) });
  }

  if (!BLOCK5_TEMPLATE_RE.test(b5))
    issues.push({ code: "BLOCK5_ALTERED", severity: "ERROR", message: "CTA line altered", sample: sample(b5) });

  if (!b6.includes("奇绩创坛"))
    issues.push({ code: "BLOCK6_ALTERED", severity: "ERROR", message: "signature missing 奇绩创坛", sample: sample(b6) });

  const joined = blocks.join(" ");
  for (const ph of ["{{REP_NAME}}", "{{REP_WECHAT}}"]) {
    if (joined.includes(ph)) {
      issues.push({
        code: queueMode ? "SERVER_PLACEHOLDER_PRESENT" : "SERVER_PLACEHOLDER_UNFILLED",
        severity: queueMode ? "WARN" : "ERROR",
        message: `${ph} present`,
      });
    }
  }

  const probe = joined.replaceAll("{{", "").replaceAll("}}", "");
  const m = probe.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  if (m) issues.push({ code: "FSTRING_LEAK", severity: "ERROR", message: `unrendered placeholder ${m[0]}` });
}

function validate(subject, html, toEmail, queueMode) {
  const issues = [];
  checkSubject(subject || "", issues);
  const blocks = splitBlocks(html || "");
  if (blocks.length !== 6) {
    issues.push({ code: "BLOCK_COUNT", severity: "ERROR", message: `expected 6 blocks, got ${blocks.length}` });
    return { ok: false, issues, blocks };
  }
  checkGreeting(blocks[0], issues);
  checkIntro(blocks[1], issues);
  checkFixedBlocks(blocks, toEmail, queueMode, issues);
  const ok = !issues.some(i => i.severity === "ERROR");
  return { ok, issues, blocks };
}

// ---- main ----
const raw = JSON.parse(fs.readFileSync(INPUT, "utf8"));
const leads = raw.leads;

const results = [];
const codeCounts = {};
const byStatus = {};

for (const lead of leads) {
  // queueMode = true for status != "ready"; status="ready" means rep can hit send,
  // so unfilled {{REP_*}} should hard-error there.
  const queueMode = lead.status !== "ready";
  const r = validate(lead.draft_subject, lead.draft_html, lead.author_email, queueMode);
  for (const issue of r.issues) {
    codeCounts[issue.code] = (codeCounts[issue.code] || 0) + 1;
  }
  byStatus[lead.status] ||= { total: 0, pass: 0, fail: 0, warn_only: 0 };
  byStatus[lead.status].total++;
  if (r.ok && r.issues.length === 0) byStatus[lead.status].pass++;
  else if (r.ok) byStatus[lead.status].warn_only++;
  else byStatus[lead.status].fail++;

  results.push({
    id: lead.id,
    author_name: lead.author_name,
    author_email: lead.author_email,
    title: lead.title,
    assigned_rep_id: lead.assigned_rep_id,
    lead_tier: lead.lead_tier,
    status: lead.status,
    created_at: lead.created_at,
    qc_ok: r.ok,
    qc_summary: r.ok
      ? (r.issues.length === 0 ? "PASS" : `PASS (${r.issues.length} warn)`)
      : `FAIL (${r.issues.filter(i => i.severity === "ERROR").length} err, ${r.issues.filter(i => i.severity === "WARN").length} warn)`,
    error_codes: r.issues.filter(i => i.severity === "ERROR").map(i => i.code),
    warning_codes: r.issues.filter(i => i.severity === "WARN").map(i => i.code),
    issues: r.issues,
  });
}

fs.writeFileSync(OUTPUT, JSON.stringify({
  total: results.length,
  by_status: byStatus,
  code_counts: codeCounts,
  generated_at: new Date().toISOString(),
  results,
}, null, 2));

console.log(`\n=== TEMPLATE-LOCK AUDIT: ${results.length} unsent drafts ===\n`);
console.log("By status:");
for (const [s, b] of Object.entries(byStatus).sort()) {
  console.log(`  ${s.padEnd(10)}  total=${b.total}  pass=${b.pass}  warn-only=${b.warn_only}  FAIL=${b.fail}`);
}
console.log("\nTop failure codes:");
const sorted = Object.entries(codeCounts).sort((a, b) => b[1] - a[1]);
for (const [code, n] of sorted.slice(0, 20)) {
  console.log(`  ${n.toString().padStart(5)}  ${code}`);
}
console.log(`\nFull report: ${OUTPUT}`);
