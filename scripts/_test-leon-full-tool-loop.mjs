// Drive Leon end-to-end on a realistic "造个工具" request:
//   1. Synthesize a Lark-shaped admin DM saying "造一个能查最近 7 天每 segment 的 wechat 转化率的工具"
//   2. Run Leon's full agent loop (lark-agent.processInboundLarkMessage shape)
//   3. Capture what tools it called, what proposal it emitted
//   4. If it called propose_tool — simulate admin Yes on the card
//   5. After approval, call the new tool by name and verify it executes
//   6. Report the trace.

import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { runReadTool, extractReadToolCalls, stripReadToolCalls } = await import("/Users/xingzewang/Desktop/mail/src/lib/helper-read-tools.ts");
const { processAdminInboxCardAction } = await import("/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts");
const { llmChat } = await import("/Users/xingzewang/Desktop/mail/src/lib/llm-proxy.ts");
const { SYSTEM_BASE, TOOLS_PROMPT } = await import("/Users/xingzewang/Desktop/mail/src/lib/lark-agent-prompt.ts").catch(() => ({}));

// Cheap version of runAgent: doesn't pull learnings or history, just
// reproduces the lookup-loop with the standard system prompt. Goal is
// to see "does Leon reach for propose_tool when asked?"
async function runMiniAgent(session, userMessage) {
  // Pull the system + tools catalog from the lark-agent source so
  // we have the same prompt Leon sees in prod.
  const lark = await import("/Users/xingzewang/Desktop/mail/src/lib/lark-agent.ts");
  // lark-agent doesn't export SYSTEM_BASE/TOOLS_PROMPT. We'll read the
  // file and slice out the parts we need.
  const srcText = readFileSync("/Users/xingzewang/Desktop/mail/src/lib/lark-agent.ts", "utf8");
  // Heuristic: SYSTEM_BASE is a `const SYSTEM_BASE = \`...\`;` and
  // TOOLS_PROMPT is similar. Just take everything between the opening
  // and matching closing backtick of those declarations.
  function extractBacktick(name) {
    const startIdx = srcText.indexOf(`const ${name} = \``);
    if (startIdx < 0) return "";
    const tickStart = srcText.indexOf("`", startIdx);
    const tickEnd = srcText.indexOf("`;", tickStart + 1);
    return srcText.slice(tickStart + 1, tickEnd);
  }
  const SYSTEM_BASE = extractBacktick("SYSTEM_BASE");
  // TOOLS_PROMPT comes from helper-tools.ts
  const helperToolsSrc = readFileSync("/Users/xingzewang/Desktop/mail/src/lib/helper-tools.ts", "utf8");
  const tpStart = helperToolsSrc.indexOf("export const TOOLS_PROMPT");
  const tickStart = helperToolsSrc.indexOf("`", tpStart);
  const tickEnd = helperToolsSrc.indexOf("`;", tickStart + 1);
  const TOOLS_PROMPT = helperToolsSrc.slice(tickStart + 1, tickEnd);

  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT;
  let userPrompt = `## 用户问题 (Admin, role=admin)\n${userMessage}\n\n记住: 涉及具体数字时, 必须先 \`\`\`lookup\`\`\`. 想造工具时用 propose_tool.`;

  const toolCallsLog = [];
  const MAX = 5;
  let finalText = "";

  for (let iter = 0; iter < MAX; iter++) {
    console.log(`\n  [iter ${iter + 1}] calling LLM...`);
    const r = await llmChat({
      model: "claude-opus-4.7",
      system,
      user: userPrompt,
      temperature: 0.4,
      max_tokens: 4000,
    });
    const text = r.text ?? "";
    const calls = extractReadToolCalls(text);
    console.log(`  [iter ${iter + 1}] LLM emitted ${calls.length} tool call(s): ${calls.map((c) => c.tool).join(", ") || "<no tools>"}`);

    if (calls.length === 0) {
      finalText = text;
      break;
    }
    const results = await Promise.all(calls.map((c) => runReadTool(session, c)));
    for (const r2 of results) toolCallsLog.push({ tool: r2.tool, result: r2.result });

    const summary = results.map((r2, i) =>
      `### ${calls[i].tool}(${JSON.stringify(calls[i].args).slice(0, 200)}) →\n${JSON.stringify(r2.result).slice(0, 2000)}`
    ).join("\n\n");
    userPrompt = `${userPrompt}\n\n## 工具查询结果 (round ${iter + 1})\n${summary}`;

    if (iter === MAX - 1) {
      const final = await llmChat({
        model: "claude-opus-4.7",
        system,
        user: userPrompt + "\n\n这是最后一轮, 给最终回答.",
        temperature: 0.4,
        max_tokens: 2000,
      });
      finalText = stripReadToolCalls(final.text ?? "");
    }
  }
  return { finalText: stripReadToolCalls(finalText), toolCallsLog };
}

const session = { repId: 5, role: "admin", repName: "Xingze (smoke)", email: "smoke@e.com" };

console.log("\n═══ STEP 1: Ask Leon to make a new tool ═══");
const userMsg = "我经常想知道'最近 7 天每个 geo (cn/edu/overseas) 的 wechat 转化数', 你能给我造一个永久工具吗?";
console.log("Admin DM:", userMsg);

const { finalText, toolCallsLog } = await runMiniAgent(session, userMsg);

console.log("\n═══ Leon's tool-call trace ═══");
for (const c of toolCallsLog) {
  console.log(`  ${c.tool}:`, JSON.stringify(c.result).slice(0, 200) + (JSON.stringify(c.result).length > 200 ? "..." : ""));
}

console.log("\n═══ Leon's final reply ═══");
console.log(finalText.slice(0, 600));

// Did Leon call propose_tool?
const proposeCalls = toolCallsLog.filter((c) => c.tool === "propose_tool");
if (proposeCalls.length === 0) {
  console.log("\n❌ Leon did NOT call propose_tool. Loop ended early.");
  process.exit(1);
}
const proposalResult = proposeCalls[proposeCalls.length - 1].result;
console.log("\n✅ propose_tool was called. Result:", proposalResult);

if (!proposalResult.ok) {
  console.log("❌ Proposal failed:", proposalResult.error);
  process.exit(1);
}
const toolId = proposalResult.id;
const inboxId = proposalResult.inbox_id;

console.log("\n═══ STEP 2: Admin (us) clicks Yes on the Lark card ═══");
const { data: admin } = await supabase.from("sales_reps").select("lark_open_id").eq("id", 5).maybeSingle();
const clickRes = await processAdminInboxCardAction({
  event: {
    operator: { open_id: admin?.lark_open_id ?? "ou_smoke" },
    action: { value: { admin_inbox_action: "yes", inbox_id: inboxId } },
  },
});
console.log("Click result:", clickRes);

const { data: tool } = await supabase.from("dynamic_tools").select("name, status, sql_template, param_order, args_schema").eq("id", toolId).maybeSingle();
console.log("\nTool now in DB:", { name: tool?.name, status: tool?.status });
console.log("SQL:", tool?.sql_template);

if (tool?.status !== "approved") {
  console.log("❌ Tool did NOT flip to approved");
  process.exit(1);
}

console.log("\n═══ STEP 3: Leon (us) calls the new tool by name ═══");
const callRes = await runReadTool(session, { tool: tool.name, args: {} });
console.log("Tool call result:", JSON.stringify(callRes.result).slice(0, 600));

console.log("\n═══ Cleanup ═══");
await supabase.from("dynamic_tools").delete().eq("id", toolId);
if (inboxId) await supabase.from("admin_inbox").delete().eq("id", inboxId);

if (callRes.result.error) {
  console.log("⚠️  Tool executed but errored:", callRes.result.error);
} else if (callRes.result.dynamic === true && Array.isArray(callRes.result.rows)) {
  console.log(`\n✅ FULL LOOP VERIFIED. Leon authored '${tool.name}', admin approved, ${callRes.result.row_count} rows returned.`);
} else {
  console.log("⚠️  Tool executed but result shape unexpected:", callRes.result);
}
