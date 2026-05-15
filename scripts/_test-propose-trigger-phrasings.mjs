// Test 5 different phrasings of the SAME underlying need (recurring count
// per geo per week) and see which trigger propose_tool.
//
// Goal: surface the gap between "user describes need naturally" and
// "Leon recognizes this as a permanent-tool opportunity."
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

const session = { repId: 5, role: "admin", repName: "Xingze", email: "x@e.com" };

async function runOne(label, msg) {
  console.log(`\n══ ${label} ══`);
  console.log(`Admin: "${msg}"`);
  let userPrompt = `## 用户问题 (Admin)\n${msg}`;
  const toolsCalled = [];
  let finalText = "";

  for (let iter = 0; iter < 4; iter++) {
    let r;
    for (let retry = 0; retry < 3; retry++) {
      try {
        r = await llmChat({ model: "claude-opus-4.7", system, user: userPrompt, temperature: 0.4, max_tokens: 2500 });
        break;
      } catch (e) {
        if (retry === 2) throw e;
        await new Promise((rs) => setTimeout(rs, 2000));
      }
    }
    const text = r.text ?? "";
    const calls = extractReadToolCalls(text);
    if (calls.length === 0) { finalText = text; break; }
    for (const c of calls) toolsCalled.push(c.tool);
    const results = await Promise.all(calls.map((c) => runReadTool(session, c)));
    const summary = results.map((r2, i) => `### ${calls[i].tool} → ${JSON.stringify(r2.result).slice(0, 1200)}`).join("\n");
    userPrompt = `${userPrompt}\n\n## 工具结果 (round ${iter + 1})\n${summary}`;
  }

  const proposed = toolsCalled.includes("propose_tool");
  console.log(`  Tools: ${toolsCalled.join(", ") || "<none>"}`);
  console.log(`  propose_tool? ${proposed ? "✅" : "❌"}`);
  console.log(`  Reply head: ${finalText.slice(0, 200).replace(/\n/g, " ")}`);
  return { label, msg, toolsCalled, proposed, replyHead: finalText.slice(0, 300) };
}

const tests = [
  { label: "P1: most explicit", msg: "造一个 dynamic_tool, 能查每个 geo 过去 N 天的 wechat 转化数" },
  { label: "P2: recurring/temporal", msg: "我每个 monday 都想看 cn / edu / overseas 上周分别有多少 wechat 转化" },
  { label: "P3: 'I keep doing this'", msg: "我每周都要手动跑一遍这个查询 — 各 geo 上周 wechat 转化数, 烦死了" },
  { label: "P4: workflow framing", msg: "周报里我都要写各 geo 的 wechat 转化, 你能让我以后不用再来问吗" },
  { label: "P5: bare single-shot (control)", msg: "上周 cn 有多少 wechat 转化?" },
];

const results = [];
for (const t of tests) {
  try {
    results.push(await runOne(t.label, t.msg));
  } catch (e) {
    console.log(`  ❌ error: ${String(e).slice(0, 150)}`);
    results.push({ label: t.label, msg: t.msg, error: true });
  }
}

console.log("\n══ SUMMARY ══");
for (const r of results) {
  console.log(`  ${r.proposed ? "✅" : "❌"}  ${r.label}`);
}
// Cleanup any rows created
await supabase.from("dynamic_tools").delete().like("name", "%wechat%geo%");
await supabase.from("dynamic_tools").delete().like("name", "%geo%wechat%");
await supabase.from("admin_inbox").delete().like("headline", "🧰 Leon 想造工具%");
