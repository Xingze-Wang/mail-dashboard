// Just test 2 in isolation: implicit recurring need
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";
const { runReadTool, extractReadToolCalls } = await import("/Users/xingzewang/Desktop/mail/src/lib/helper-read-tools.ts");
const { llmChat } = await import("/Users/xingzewang/Desktop/mail/src/lib/llm-proxy.ts");
const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const session = { repId: 5, role: "admin", repName: "Xingze", email: "x@e.com" };
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

const msg = "我每周一都想看 cn 的 lead 进展, 你能帮我每次直接拿数据吗?";
console.log("Admin:", msg);
let userPrompt = `## 用户问题 (Admin)\n${msg}`;
const toolsCalled = [];
let finalText = "";
for (let iter = 0; iter < 4; iter++) {
  const r = await llmChat({ model: "claude-opus-4.7", system, user: userPrompt, temperature: 0.4, max_tokens: 3000 });
  const text = r.text ?? "";
  const calls = extractReadToolCalls(text);
  if (calls.length === 0) { finalText = text; break; }
  for (const c of calls) toolsCalled.push(c.tool);
  const results = await Promise.all(calls.map((c) => runReadTool(session, c)));
  const summary = results.map((r2, i) => `### ${calls[i].tool}(${JSON.stringify(calls[i].args).slice(0, 150)}) →\n${JSON.stringify(r2.result).slice(0, 1500)}`).join("\n\n");
  userPrompt = `${userPrompt}\n\n## 工具结果 (round ${iter + 1})\n${summary}`;
}
console.log("\nTools called:", toolsCalled.join(", "));
console.log("propose_tool?", toolsCalled.includes("propose_tool") ? "✅ YES" : "❌ NO");
console.log("\nReply:");
console.log(finalText);

// Cleanup any rows
await supabase.from("dynamic_tools").delete().like("name", "%cn%");
await supabase.from("admin_inbox").delete().like("headline", "🧰%cn%");
