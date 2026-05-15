// Test whether Leon recognizes implicit "I want this regularly" requests
// as a propose_tool trigger, vs. only the explicit "造个工具" request.
//
// Three test prompts, escalating subtlety:
//   1. "Build me a tool to count cn leads weekly"  ← explicit (positive control)
//   2. "I keep wondering how many cn leads we get each week — answer me"  ← recurring need, no build keyword
//   3. "How many cn leads this week?"  ← single-shot, should NOT trigger propose
//
// For each, capture which tools Leon calls. Hypothesis: today only #1
// triggers propose_tool. The PM concern is that #2 SHOULD also trigger
// it (it's a recurring need stated naturally).

import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { runReadTool, extractReadToolCalls, stripReadToolCalls } = await import("/Users/xingzewang/Desktop/mail/src/lib/helper-read-tools.ts");
const { llmChat } = await import("/Users/xingzewang/Desktop/mail/src/lib/llm-proxy.ts");
const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");

const session = { repId: 5, role: "admin", repName: "Xingze", email: "x@e.com" };

// Reuse the lark-agent prompt extraction trick from earlier smoke
const srcText = readFileSync("/Users/xingzewang/Desktop/mail/src/lib/lark-agent.ts", "utf8");
function extractBacktick(name, src) {
  const startIdx = src.indexOf(`const ${name} = \``);
  if (startIdx < 0) return "";
  const tickStart = src.indexOf("`", startIdx);
  const tickEnd = src.indexOf("`;", tickStart + 1);
  return src.slice(tickStart + 1, tickEnd);
}
const SYSTEM_BASE = extractBacktick("SYSTEM_BASE", srcText);
const helperToolsSrc = readFileSync("/Users/xingzewang/Desktop/mail/src/lib/helper-tools.ts", "utf8");
const tpStart = helperToolsSrc.indexOf("export const TOOLS_PROMPT");
const tickStart = helperToolsSrc.indexOf("`", tpStart);
const tickEnd = helperToolsSrc.indexOf("`;", tickStart + 1);
const TOOLS_PROMPT = helperToolsSrc.slice(tickStart + 1, tickEnd);
const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT;

async function runOnePrompt(label, userMessage) {
  console.log(`\n═══ ${label} ═══`);
  console.log(`Admin: ${userMessage}`);
  const proposalsBefore = await supabase.from("dynamic_tools").select("id", { count: "exact", head: true });

  let userPrompt = `## 用户问题 (Admin)\n${userMessage}`;
  const toolsCalled = [];
  let finalText = "";

  for (let iter = 0; iter < 4; iter++) {
    const r = await llmChat({
      model: "claude-opus-4.7",
      system,
      user: userPrompt,
      temperature: 0.4,
      max_tokens: 3000,
    });
    const text = r.text ?? "";
    const calls = extractReadToolCalls(text);
    if (calls.length === 0) { finalText = text; break; }
    for (const c of calls) toolsCalled.push(c.tool);
    const results = await Promise.all(calls.map((c) => runReadTool(session, c)));
    const summary = results.map((r2, i) =>
      `### ${calls[i].tool}(${JSON.stringify(calls[i].args).slice(0, 150)}) →\n${JSON.stringify(r2.result).slice(0, 1500)}`
    ).join("\n\n");
    userPrompt = `${userPrompt}\n\n## 工具结果 (round ${iter + 1})\n${summary}`;
  }

  const proposalsAfter = await supabase.from("dynamic_tools").select("id", { count: "exact", head: true });
  const newProposals = (proposalsAfter.count ?? 0) - (proposalsBefore.count ?? 0);

  console.log("Tools called:", toolsCalled.join(", "));
  console.log("propose_tool called?", toolsCalled.includes("propose_tool") ? "✅" : "❌");
  console.log("new dynamic_tools rows:", newProposals);
  console.log("Reply (first 250 chars):", finalText.slice(0, 250));

  return { toolsCalled, newProposals, finalText };
}

const tests = [
  { label: "TEST 1 (explicit)", msg: "造一个工具, 能查最近 7 天 cn 的 lead 数量" },
  { label: "TEST 2 (implicit recurring)", msg: "我每周一都想看 cn 的 lead 进展, 你能帮我每次直接拿数据吗?" },
  { label: "TEST 3 (single-shot)", msg: "这周 cn 的 lead 有多少?" },
];

const results = [];
for (const t of tests) {
  try {
    results.push({ ...await runOnePrompt(t.label, t.msg), label: t.label });
  } catch (err) {
    console.log(t.label, "→ error:", String(err).slice(0, 200));
    results.push({ label: t.label, error: true });
  }
}

console.log("\n═══ HYPOTHESIS CHECK ═══");
const t1 = results[0];
const t2 = results[1];
const t3 = results[2];
console.log("Test 1 (explicit 'build') should trigger propose_tool:", t1?.toolsCalled?.includes("propose_tool") ? "✅" : "❌");
console.log("Test 2 (implicit recurring) should trigger propose_tool:", t2?.toolsCalled?.includes("propose_tool") ? "✅" : "❌ ← PM concern confirmed if this is ❌");
console.log("Test 3 (single-shot) should NOT trigger propose_tool:", !t3?.toolsCalled?.includes("propose_tool") ? "✅" : "❌ false positive");

// Cleanup any rows created
await supabase.from("dynamic_tools").delete().like("name", "%cn%");
await supabase.from("admin_inbox").delete().like("headline", "🧰 Leon 想造工具%cn%");
