import { NextRequest, NextResponse } from "next/server";
import { llmChat } from "@/lib/llm-proxy";
import { QIJI_PROGRAM_FACTS } from "@/lib/qiji-facts";
import { SALES_GUIDE } from "@/lib/sales-guide-corpus";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/help/ask
 * Body: { question: string, currentPath?: string, history?: {role, text}[] }
 *
 * App-wide help bot. Different from /api/brief/ask in that it's not tied to
 * a specific lead — handles "how do I do X in this app" + "对方问 X 怎么答"
 * questions equally. Grounds responses in:
 *   - Qiji Compute facts (program details, official FAQ, sales playbook)
 *   - Sales Guide (UI workflow, keyboard shortcuts, troubleshooting)
 *   - currentPath (so "where do I find X" can answer in context)
 *
 * Multi-turn: pass last 4 messages in `history` for follow-ups.
 */

const SYSTEM = `你是 Qiji Pipeline 的销售助手 (Sales Copilot)。

你的工作分两类：
1. **怎么用 app** — 用户问"X 在哪里"/"怎么 Y" → 看 Sales Guide 回答, 给具体路径
2. **对方问什么怎么答** — 用户问"对方问 X 我怎么回" → 看 Qiji Compute facts, 给可以照着说的中文话术

回答风格：
- 中文, 口语化, 短
- 直接给答案 + 1-2 句铺垫, 不要长篇大论
- 多种答法用 1./2./3. 列出
- 不要 markdown 标题
- 引用 UI 元素时用粗体 (**Pipeline** **Review** **Send** 等)

绝对原则：
- 这是「奇绩算力 (Compute)」program。**严禁**回答「奇绩创业营 (Accelerator)」相关问题（投资金额/股权比例/batch 时间/北京线下营等）。
  → 被问到创业营时回答："那是另一个程序，我帮你转给 mentor team 详细聊。"
- 不要瞎编数字、政策、流程。不确定就说"这个我也不太确定，找 Xingze 确认"。
- 不要承诺超出 facts 的东西。`;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const question = String(body.question ?? "").trim();
  const currentPath = String(body.currentPath ?? "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-4) : [];

  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: "question too long (max 500 chars)" }, { status: 400 });

  // Build user message with history + corpus
  const historyText = history.length > 0
    ? "\n## 上文对话\n" + history.map((m: { role: string; text: string }) =>
        `${m.role === "user" ? "用户" : "助手"}: ${String(m.text).slice(0, 600)}`
      ).join("\n") + "\n"
    : "";

  const pathHint = currentPath
    ? `\n用户当前在页面: ${currentPath}\n（"这里"/"这个页面"指的是这个路径。）\n`
    : "";

  const user = `## Sales Guide
${SALES_GUIDE}

## Qiji Compute Facts
${QIJI_PROGRAM_FACTS}
${pathHint}${historyText}
## 用户问题
${question}

请回答。`;

  let answer = "";
  let model = "";
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: SYSTEM,
      user,
      temperature: 0.4,
      max_tokens: 800,
      timeoutMs: 25_000,
    });
    answer = r.text.trim();
    model = "gemini-3-flash";
  } catch {
    try {
      const r = await llmChat({
        model: "gemini-3-pro",
        system: SYSTEM,
        user,
        temperature: 0.4,
        max_tokens: 800,
        timeoutMs: 25_000,
      });
      answer = r.text.trim();
      model = "gemini-3-pro";
    } catch (e2) {
      return NextResponse.json(
        { error: `LLM unavailable: ${e2 instanceof Error ? e2.message : String(e2)}` },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ answer, model });
}
