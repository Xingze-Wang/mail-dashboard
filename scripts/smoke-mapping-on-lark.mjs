// Smoke the mapping workflow as it actually runs on Lark.
// We test that the LLM, given the mapping tool docs in TOOLS_PROMPT,
// emits the right ```lookup``` blocks for mapping-style prompts.

import "dotenv/config";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const PROXY_URL = "https://openai-proxy.miracleplus.com/v1/chat/completions";
const PROXY_KEY = process.env.MIRACLEPLUS_PROXY_KEY;
if (!PROXY_KEY) { console.error("MIRACLEPLUS_PROXY_KEY missing"); process.exit(1); }

const SYSTEM = [
  "你是 Qiji 算力 program 的销售搭档. Lark 里的同事在跟你聊天.",
  "",
  "## 工具系统",
  "查询工具调用嵌入回答中:",
  "```lookup",
  '{"tool": "<name>", "args": {...}}',
  "```",
  "",
  "### Mapping team 工具 (mapping people 是另一组同事 role='mapping', 每封邮件先批准再发):",
  "- get_my_targets — 当前 rep 的所有 mapping target. args: {}.",
  "- get_pending_drafts — 等批准的 drafts. args: { target_id?: uuid, limit?: 10 }.",
  "- create_mapping_target — 创建新 target. args: { label, spec: {vertical?, topic_keywords?, schools?, school_tier?, geo?, h_index_min?, citation_count_min?}, guidelines? }.",
  "- find_mapping_candidates — args: { target_id: uuid, limit?: 10 }.",
  "- draft_for_lead — args: { target_id: uuid, lead_id: uuid }. 不会自动发.",
  '- decide_draft — args: { draft_id: uuid, decision: "approve" | "reject" | "edit_and_approve", edited_subject?, edited_body_html?, reject_reason? }.',
  "- run_target_evolution — admin only. args: { target_id: uuid }.",
  "",
  "## 硬规则",
  "- 涉及具体数字 / lead → 先 lookup, 别拍脑袋.",
  "- 创建 target / draft 之前简短确认意图.",
  "",
  "## 风格",
  "中文为主. 朴实. 直接.",
].join("\n");

async function llm(user) {
  const r = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + PROXY_KEY },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      temperature: 0.4,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()).slice(0, 100));
  return ((await r.json()).choices?.[0]?.message?.content ?? "").trim();
}

function extractLookups(text) {
  const out = [];
  const re = /```lookup\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed.tool === "string") out.push(parsed);
    } catch {}
  }
  return out;
}

const cases = [
  { id: "list_targets",   user: "我有几个 target?", expectTool: "get_my_targets" },
  { id: "list_pending",   user: "有什么 draft 在等我批准?", expectTool: "get_pending_drafts" },
  { id: "create_target",  user: "帮我建一个新 target — MIT 的量子物理 postdocs, 主要找做量子计算的.", expectToolOptions: ["create_mapping_target"], requireConfirmText: true },
  { id: "find_candidates", user: "OK 给 target_id=01234567-89ab-cdef-0123-456789abcdef 找 5 个候选 leads", expectTool: "find_mapping_candidates" },
  { id: "draft_for_lead", user: "给 lead_id=lead-uuid-123 起草一封 (target_id=01234567-89ab-cdef-0123-456789abcdef)", expectTool: "draft_for_lead" },
  { id: "approve_draft",  user: "draft_id=draft-uuid-456 直接批准发出去吧", expectTool: "decide_draft" },
];

let passed = 0, failed = 0;
const results = [];
for (const t of cases) {
  process.stdout.write("  " + t.id + "... ");
  try {
    const reply = await llm("## 用户问题 (来自 Lark, rep=张明, role=mapping)\n" + t.user);
    const lookups = extractLookups(reply);
    let ok = false;
    let detail = "";
    if (t.expectToolOptions) {
      const got = lookups.map(l => l.tool);
      ok = t.expectToolOptions.some(opt => got.includes(opt));
      if (!ok && t.requireConfirmText) {
        if (/对吗|可以吗|确认|建吗|要不|是吗|这样/.test(reply)) { ok = true; detail = "asked for confirmation (acceptable)"; }
      }
      if (!detail) detail = "lookups=" + JSON.stringify(got);
    } else {
      const got = lookups.map(l => l.tool);
      ok = got.includes(t.expectTool);
      detail = "lookups=" + JSON.stringify(got);
    }
    if (ok) passed++; else failed++;
    console.log((ok ? "✓" : "✗") + "  " + detail);
    results.push({ ...t, reply, lookups, ok });
  } catch (e) {
    failed++;
    console.log("✗  ERROR: " + String(e).slice(0, 120));
    results.push({ ...t, error: String(e), ok: false });
  }
}

console.log("\n=== " + passed + "/" + cases.length + " passed ===\n");
if (failed > 0) {
  console.log("MISSES:");
  for (const r of results.filter(r => !r.ok)) {
    console.log("\n[" + r.id + "] expected: " + (r.expectTool ?? r.expectToolOptions?.join("|")));
    console.log("  reply: " + (r.reply ?? "").slice(0, 400));
    console.log("  lookups: " + JSON.stringify(r.lookups ?? []));
  }
}
process.exit(failed === 0 ? 0 : 1);
