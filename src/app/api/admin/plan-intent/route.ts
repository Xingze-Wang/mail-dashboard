// /api/admin/plan-intent — turn admin's natural-language intent into a
// guided_task plan. Two-phase:
//   POST { intent, constraints? }       → returns { plan: { goal, steps[] } }
//   POST { intent, submit: true, plan } → creates the actual proposal
//                                          via proposeGuidedTask (which
//                                          pushes admin a Lark Yes/No card)

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";

export const preferredRegion = ["hkg1"];
export const maxDuration = 30;

interface PlanStep {
  intent: string;
  verification?: string;
}

interface PlanPreview {
  goal: string;
  steps: PlanStep[];
  rationale?: string;
}

async function isAdmin(req: NextRequest): Promise<{ repId: number } | null> {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return { repId: session.repId };
}

async function planFromIntent(intent: string, constraints?: string): Promise<PlanPreview | { error: string }> {
  const system = `你是 Leon, 一个 sales agent. Admin 告诉你一个目标, 你需要拆成可执行的多步 plan, 每步是 Leon 自己能做的事 (用已有工具).

可用工具 (你能调的):
- lookup tools: list_leads / get_lead / get_lead_counts / list_reps / get_my_stats / etc.
- propose_db_write: 改一行 DB (允许的表: sales_reps, pipeline_leads, helper_learnings, admin_inbox, rep_questions, canonical_onboarding_topics, dynamic_tools, dynamic_writes, doc_edit_proposals)
- propose_doc_edit: 改飞书 doc
- dm_user / dm_chat: 给 Lark 用户/群发消息
- create_rich_lark_doc: 创建飞书 doc
- send_lead_email: 发邮件 (sales rep 自己决定)
- record_admin_request: 推一张 admin_inbox 卡 (一般用于 escalation)

**禁止**: 直接改 emails / webhook_events / lark_messages / helper_messages 等审计表.

输出**只有 JSON**, 不要解释:
{
  "goal": "一句话总结 admin 的需求",
  "rationale": "一两句话说明为什么这么拆步骤 (admin 看 plan 时帮他评估)",
  "steps": [
    { "intent": "Step 0: 我要做 X (具体到调哪个 tool)", "verification": "我预期看到 Y" },
    ...
  ]
}

写 steps 的规则:
- 每步**只做一件可独立验证的事** (一个 lookup, 一个 propose_db_write, 一个 dm_user)
- intent 用第一人称 + 具体工具名 (e.g. "我会 lookup get_lead_counts 拿 cn 的数量")
- verification 写**怎么知道这步真做对了** (具体到看到什么字段)
- 总步数 1-7 步, 超过就拆 task
- 如果 admin 的需求**不需要分步** (e.g. 一个 SQL 写就完事), 也可以只写 1 步
- 如果需求**模糊到无法拆**, 返回 { "goal": "...", "steps": [], "rationale": "需要 admin 澄清 X" }`;

  const userPrompt = `Admin 的目标:\n${intent}${constraints ? `\n\n约束:\n${constraints}` : ""}\n\n输出 plan JSON.`;

  const r = await llmChat({
    model: "claude-opus-4.7",
    system,
    user: userPrompt,
    temperature: 0.3,
    max_tokens: 2000,
  });
  const text = (r.text ?? "").trim().replace(/^```json\s*|\s*```$/g, "");
  try {
    const j = JSON.parse(text);
    if (typeof j.goal !== "string" || !Array.isArray(j.steps)) {
      return { error: "LLM returned invalid plan shape" };
    }
    return {
      goal: j.goal.slice(0, 1000),
      rationale: typeof j.rationale === "string" ? j.rationale.slice(0, 1000) : undefined,
      steps: j.steps
        .map((s: { intent?: string; verification?: string }) => ({
          intent: String(s.intent ?? "").slice(0, 500),
          verification: s.verification ? String(s.verification).slice(0, 500) : undefined,
        }))
        .filter((s: PlanStep) => s.intent.length >= 5),
    };
  } catch {
    return { error: "Failed to parse plan JSON" };
  }
}

export async function POST(req: NextRequest) {
  const admin = await isAdmin(req);
  if (!admin) return NextResponse.json({ error: "admin only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    intent?: string;
    constraints?: string;
    submit?: boolean;
    plan?: PlanPreview;
  };
  const intent = (body.intent ?? "").trim();
  if (!intent) return NextResponse.json({ error: "intent required" }, { status: 400 });

  // Phase 2: submit the plan as a guided_task
  if (body.submit && body.plan) {
    const { proposeGuidedTask } = await import("@/lib/guided-tasks");
    const r = await proposeGuidedTask({
      goal: body.plan.goal,
      constraints: body.constraints,
      steps: body.plan.steps,
      proposed_by_rep_id: admin.repId,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, task_id: r.id, inbox_id: r.inbox_id });
  }

  // Phase 1: plan it
  const plan = await planFromIntent(intent, body.constraints);
  if ("error" in plan) return NextResponse.json({ error: plan.error }, { status: 500 });
  return NextResponse.json({ ok: true, plan });
}
