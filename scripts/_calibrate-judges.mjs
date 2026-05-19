#!/usr/bin/env node
// Calibration: sample emails across the QC spectrum, run each through three
// independent LLM judges in parallel (Sonnet 4.6 + Gemini 2.5 Flash direct +
// GLM 4.7), emit per-email side-by-side scores so the user can choose a
// threshold before locking the gate into production.
//
// v2 (2026-05-19): fixes from v1:
//  - Direct proxy POST for Sonnet too (skip the .ts import which fails under
//    plain node)
//  - Strip Gemini's leading whitespace / markdown fences more aggressively
//  - Log raw text on parse failure so we can see what each judge returned
//  - Sample-bucket query: pull each bucket independently (not via .limit
//    chain) so we actually get a mix

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith("--limit="));
const limit = Number(limitArg ? limitArg.split("=")[1] : 18);

function extractIntro(html) {
  if (!html) return "";
  let t = html.replace(/<br\s*\/?>/gi, "<br>").replace(/<\/?(?:html|head|body|meta)[^>]*>/gi, "");
  const parts = t.split(/(?:<br>\s*){2,}/).map((p) =>
    p.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim(),
  ).filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}

function buildJudgePrompt(intro, paperTitle, paperAbstract) {
  return `你正在审核一封要发给科研作者的销售邮件的 personalized intro (1 句话)。

邮件目标：邀请作者申请奇绩算力（免费 GPU 资源）。
intro 应当是 1 句中文，四段论结构：
  1) "最近在跟踪[X方向]的研究时"
  2) "读到你的[paper名]"
  3) "其中[Y方法]解决[Z问题]的方案很有启发"
  4) "如果能有更多算力支持，相信可以..."

对这封邮件，请输出 JSON：
{
  "instruction_followed": 0-10,
  "paper_relevant": 0-10,
  "reasoning": "<不超过 80 字>",
  "should_block": true|false
}

paper 标题：${paperTitle}
paper 摘要（前 800 字）：${(paperAbstract || "").slice(0, 800)}

要审核的 intro：
"""
${intro}
"""

只输出 JSON，不要任何 markdown 或解释。`;
}

async function proxyCall(model, prompt, opts = {}) {
  // Retries on transient TypeError. Drops response_format when caller says
  // the model doesn't honor it (GLM via z-ai route returns empty body when
  // json_object is set).
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const body = {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 1500,
      };
      if (opts.useJsonMode !== false) body.response_format = { type: "json_object" };
      const res = await fetch("https://openai-proxy.miracleplus.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.MIRACLEPLUS_PROXY_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`proxy ${res.status}: ${text.slice(0, 200)}`);
      let j;
      try { j = JSON.parse(text); }
      catch { throw new Error(`proxy non-json: ${text.slice(0, 200)}`); }
      return j?.choices?.[0]?.message?.content || "";
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
    }
  }
  throw lastErr;
}

async function judgeSonnet(intro, title, abstract) {
  const raw = await proxyCall("claude-sonnet-4-6", buildJudgePrompt(intro, title, abstract));
  return parseJudgeJSON(raw);
}
async function judgeGlm(intro, title, abstract) {
  // z-ai/glm-4.7 silently returns empty content when json_object is set.
  // Skip strict mode; rely on prompt + post-parse to extract the JSON block.
  const raw = await proxyCall("z-ai/glm-4.7", buildJudgePrompt(intro, title, abstract), { useJsonMode: false });
  return parseJudgeJSON(raw);
}
async function judgeGeminiDirect(intro, title, abstract) {
  // gemini-2.5-flash burns "thinking tokens" against maxOutputTokens — needs
  // a generous budget (per template-assembler.ts:208 it took 2500 to avoid
  // mid-output truncation). Skip responseMimeType=application/json too;
  // that mode plus thinking tokens led to {"instruction_followed":10, <EOF>.
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY not set");
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: buildJudgePrompt(intro, title, abstract) }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2500 },
          }),
        },
      );
      const text = await res.text();
      if (!res.ok) throw new Error(`gemini ${res.status}: ${text.slice(0, 200)}`);
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`gemini non-json: ${text.slice(0, 200)}`); }
      const out = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return parseJudgeJSON(out);
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
    }
  }
  throw lastErr;
}

function parseJudgeJSON(text) {
  const raw = text || "";
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // Find the outermost {...} balanced block
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    const j = JSON.parse(cleaned);
    return {
      instruction_followed: Number(j.instruction_followed) || 0,
      paper_relevant: Number(j.paper_relevant) || 0,
      should_block: Boolean(j.should_block),
      reasoning: String(j.reasoning || "").slice(0, 200),
    };
  } catch {
    return {
      instruction_followed: -1,
      paper_relevant: -1,
      should_block: null,
      reasoning: `parse_fail`,
      raw: raw.slice(0, 300),
    };
  }
}

async function pickSample() {
  // Take half from clean ready, ¼ from queued, ¼ from quarantined.
  const splitN = Math.max(2, Math.floor(limit / 2));
  const queuedN = Math.max(2, Math.floor(limit / 4));
  const quarN = Math.max(2, limit - splitN - queuedN);

  const out = [];
  const queries = [
    { label: "ready_clean", n: splitN, q: () => sb.from("pipeline_leads").select("id,author_name,author_email,title,draft_html,status,assigned_rep_id,abstract").eq("status", "ready").not("draft_html", "is", null).order("created_at", { ascending: false }).limit(splitN) },
    { label: "queued",      n: queuedN, q: () => sb.from("pipeline_leads").select("id,author_name,author_email,title,draft_html,status,assigned_rep_id,abstract").eq("status", "queued").not("draft_html", "is", null).order("created_at", { ascending: false }).limit(queuedN) },
    { label: "qc_quarantined", n: quarN, q: () => sb.from("pipeline_leads").select("id,author_name,author_email,title,draft_html,status,assigned_rep_id,abstract").eq("status", "qc_quarantined").limit(quarN) },
  ];
  for (const q of queries) {
    const { data, error } = await q.q();
    if (error) { console.error(`${q.label} query failed:`, error.message); continue; }
    console.log(`  bucket ${q.label}: ${data?.length || 0} rows`);
    for (const row of data || []) out.push({ ...row, sample_label: q.label });
  }
  return out;
}

const samples = await pickSample();
console.log(`\nCalibrating ${samples.length} emails with 3 judges (Sonnet 4.6 + Gemini 2.5 Flash + GLM 4.7)...\n`);

const results = [];
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const intro = extractIntro(s.draft_html);
  if (!intro) { results.push({ ...s, intro: "", skipped: "no_intro" }); continue; }

  process.stdout.write(`[${i + 1}/${samples.length}] ${s.sample_label.padEnd(16)} ${(s.author_name || "?").slice(0, 18).padEnd(18)} ... `);
  const [sonnet, glm, gemini] = await Promise.all([
    judgeSonnet(intro, s.title || "", s.abstract || "").catch((e) => ({ error: String(e).slice(0, 100) })),
    judgeGlm(intro, s.title || "", s.abstract || "").catch((e) => ({ error: String(e).slice(0, 100) })),
    judgeGeminiDirect(intro, s.title || "", s.abstract || "").catch((e) => ({ error: String(e).slice(0, 100) })),
  ]);

  const blockVotes = [sonnet, glm, gemini].filter((j) => j?.should_block === true).length;
  const instrScores = [sonnet, glm, gemini].map((j) => j?.instruction_followed).filter((v) => v != null && v >= 0);
  const relScores = [sonnet, glm, gemini].map((j) => j?.paper_relevant).filter((v) => v != null && v >= 0);
  const validJudges = [sonnet, glm, gemini].filter((j) => j?.instruction_followed != null && j.instruction_followed >= 0).length;
  const meanInstr = instrScores.length ? (instrScores.reduce((a, b) => a + b, 0) / instrScores.length).toFixed(1) : "?";
  const meanRel = relScores.length ? (relScores.reduce((a, b) => a + b, 0) / relScores.length).toFixed(1) : "?";
  console.log(`votes=${blockVotes}/3  judges=${validJudges}/3  instr=${meanInstr}  rel=${meanRel}`);

  results.push({
    id: s.id,
    sample_label: s.sample_label,
    author_name: s.author_name,
    author_email: s.author_email,
    title: s.title,
    status: s.status,
    intro,
    sonnet,
    glm,
    gemini,
    block_votes: blockVotes,
    valid_judges: validJudges,
    mean_instr: meanInstr === "?" ? null : Number(meanInstr),
    mean_rel: meanRel === "?" ? null : Number(meanRel),
  });
}

fs.writeFileSync("/tmp/judge_calibration.json", JSON.stringify({ generated_at: new Date().toISOString(), count: results.length, results }, null, 2));
console.log(`\nWrote /tmp/judge_calibration.json (${results.length} emails)`);

// Per-bucket summary
const byLabel = {};
for (const r of results) {
  if (r.skipped) continue;
  byLabel[r.sample_label] ||= { n: 0, block_majority: 0, instr_scores: [], rel_scores: [], valid_count: [] };
  const b = byLabel[r.sample_label];
  b.n++;
  if (r.block_votes >= 2) b.block_majority++;
  if (r.mean_instr != null) b.instr_scores.push(r.mean_instr);
  if (r.mean_rel != null) b.rel_scores.push(r.mean_rel);
  b.valid_count.push(r.valid_judges);
}
console.log("\nBy bucket (mean over judges that returned valid JSON):");
console.log("  bucket              n    block_maj  mean_instr  mean_rel   judges_ok");
for (const [k, v] of Object.entries(byLabel)) {
  const mi = v.instr_scores.length ? (v.instr_scores.reduce((a, b) => a + b, 0) / v.instr_scores.length).toFixed(1) : "?";
  const mr = v.rel_scores.length ? (v.rel_scores.reduce((a, b) => a + b, 0) / v.rel_scores.length).toFixed(1) : "?";
  const judgesOk = v.valid_count.length ? (v.valid_count.reduce((a, b) => a + b, 0) / v.valid_count.length).toFixed(1) : "?";
  console.log(`  ${k.padEnd(18)} ${v.n.toString().padStart(3)}  ${(v.block_majority + "/" + v.n).padStart(8)}   ${mi.padStart(8)}    ${mr.padStart(7)}   ${judgesOk}/3`);
}
