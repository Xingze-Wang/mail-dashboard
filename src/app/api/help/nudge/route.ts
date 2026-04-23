import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/help/nudge
 * Body: { leadId: string }
 *
 * Called when a rep lingers on a Review-mode lead for >15s without
 * opening the helper. Returns a single crisp sentence the UI pops
 * above the sparkles button ("需要帮忙吗? 看起来你在想 X 篇").
 *
 * De-dup: `helper_rep_state.last_nudge_lead_id` — we only nudge once
 * per lead. If the rep already got a nudge for this lead id, return
 * skip=true and the client shuts up.
 */

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leadId = typeof body.leadId === "string" ? body.leadId : null;
  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });

  // De-dup check.
  const { data: state } = await supabase
    .from("helper_rep_state")
    .select("last_nudge_lead_id")
    .eq("rep_id", session.repId)
    .maybeSingle();
  if (state?.last_nudge_lead_id === leadId) {
    return NextResponse.json({ skip: true });
  }

  // Load lead briefly (ownership check reuses /api/pipeline/[id] semantics).
  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_name, abstract, created_at, published_at, assigned_rep_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (session.role !== "admin" && lead.assigned_rep_id !== session.repId) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const SYSTEM = `你是 rep 的搭档. 他/她在 Review 里盯着一条 lead 15 秒没动, 你主动说一句.

规则:
- **最多一句**. 15 字以内尽量.
- 不用 emoji, 不用语气词, 不用 "您".
- 目的是提供一个具体的帮助. 不要"需要帮忙吗"这种空泛话.
- 如果 paper 技术, 可以问要不要 summary.
- 如果 paper 像 survey / review, 可以问要不要快速 skim 一下重点.
- 如果完全不好判断, 就问 "看着犹豫, 要不要我帮你读一下"`;

  const user = `lead 标题: ${lead.title}
作者: ${lead.author_name ?? "?"}
abstract 前 300 字: ${(lead.abstract as string ?? "").slice(0, 300)}

rep 盯着看 15 秒没动. 写一句主动 nudge.`;

  let nudge = "";
  try {
    const r = await llmChat({ model: "gemini-3-flash", system: SYSTEM, user, temperature: 0.3, max_tokens: 60, timeoutMs: 10_000 });
    nudge = r.text.trim().replace(/^"|"$/g, "");
  } catch {
    nudge = "看着犹豫. 要我帮你读一下吗?";
  }
  // Belt: clip to ~40 chars even if LLM ignores the rule.
  if (nudge.length > 40) nudge = nudge.slice(0, 40);

  // Mark de-dup.
  await supabase
    .from("helper_rep_state")
    .upsert({
      rep_id: session.repId,
      last_nudge_lead_id: leadId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "rep_id" });

  return NextResponse.json({ skip: false, nudge });
}
