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
function eb(name, src) {
  const s = src.indexOf(`const ${name} = \``);
  if (s < 0) return "";
  const t = src.indexOf("`", s);
  const e = src.indexOf("`;", t + 1);
  return src.slice(t + 1, e);
}
const SB = eb("SYSTEM_BASE", srcText);
const ht = readFileSync("/Users/xingzewang/Desktop/mail/src/lib/helper-tools.ts", "utf8");
const tps = ht.indexOf("export const TOOLS_PROMPT");
const ts = ht.indexOf("`", tps);
const te = ht.indexOf("`;", ts + 1);
const TP = ht.slice(ts + 1, te);
const sys = SB + "\n" + TP;
const session = { repId: 5, role: "admin", repName: "Xingze", email: "x@e.com" };
const msg = "我每周都要手动跑一遍这个查询 — 各 geo 上周 wechat 转化数, 烦死了";
console.log("Admin:", msg);
let userPrompt = "## 用户问题 (Admin)\n" + msg;
const calls = [];
for (let iter = 0; iter < 4; iter++) {
  let r;
  for (let retry = 0; retry < 3; retry++) {
    try {
      r = await llmChat({ model: "claude-opus-4.7", system: sys, user: userPrompt, temperature: 0.4, max_tokens: 2500 });
      break;
    } catch (e) {
      if (retry === 2) throw e;
      await new Promise((rs) => setTimeout(rs, 2000));
    }
  }
  const c = extractReadToolCalls(r.text ?? "");
  if (c.length === 0) {
    console.log("reply:", (r.text ?? "").slice(0, 350));
    break;
  }
  for (const x of c) calls.push(x.tool);
  const results = await Promise.all(c.map((x) => runReadTool(session, x)));
  userPrompt += "\n\n## 工具结果\n" + results.map((r2, i) => "### " + c[i].tool + " → " + JSON.stringify(r2.result).slice(0, 1200)).join("\n");
}
console.log("tools called:", calls.join(", "));
console.log("propose_tool?", calls.includes("propose_tool") ? "✅" : "❌");
await supabase.from("dynamic_tools").delete().like("name", "%wechat%");
await supabase.from("admin_inbox").delete().like("headline", "🧰%wechat%");
