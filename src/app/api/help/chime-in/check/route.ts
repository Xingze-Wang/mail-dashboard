import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/help/chime-in/check
 *
 * Action-triggered chime-in (Dream #1). Frontend calls this right
 * after a notable rep action — currently only `send_email` is wired —
 * to ask: "is there something the helper should pipe up about?"
 *
 * Why a separate route from /api/help/chime-in:
 *   The existing route reads the cron-populated pending_chime_in
 *   bucket. This is a fresh per-action probe — short-lived, no
 *   persistence, no cross-session cadence. We don't want either
 *   path to interfere with the other.
 *
 * Cost guard: rate-limited to ≤ 1 chime per rep per 5 minutes (cheap
 * cooldown via helper_rep_state.last_action_chime_at). Without this,
 * a rep batch-sending 20 emails would get 20 LLM calls back-to-back.
 *
 * Body shape:
 *   { trigger: "send_email", context: { lead_id?, subject?, body_excerpt? } }
 */

const COOLDOWN_MS = 5 * 60 * 1000;

interface ChimeRequest {
  trigger: string;
  context?: {
    lead_id?: string;
    subject?: string;
    body_excerpt?: string;
  };
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as ChimeRequest;
  const trigger = String(body.trigger ?? "");
  if (trigger !== "send_email") {
    // Only one trigger wired in v1. Returning empty (not error) so the
    // frontend can fire-and-forget without case-handling per trigger.
    return NextResponse.json({ chime: null });
  }

  // Cooldown check.
  const { data: state } = await supabase
    .from("helper_rep_state")
    .select("last_action_chime_at")
    .eq("rep_id", session.repId)
    .maybeSingle();
  const last = (state?.last_action_chime_at as string | null) ?? null;
  if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) {
    return NextResponse.json({ chime: null, reason: "cooldown" });
  }

  // Pull the most recent N sends from this rep to compare against.
  // 90% of "this is just like one you sent" cases get caught by
  // looking at the last 30 sends; cheaper than vector similarity.
  const { data: lastSends } = await supabase
    .from("emails")
    .select("subject, to, created_at")
    .eq("actor_rep_id", session.repId)
    .order("created_at", { ascending: false })
    .limit(30);

  const ctx = body.context ?? {};
  if (!ctx.subject) return NextResponse.json({ chime: null });

  // Build a tiny prompt: ask the LLM whether to chime. Most calls
  // return "skip" — that's the design (chime should be rare).
  const recentSubjects = (lastSends ?? [])
    .map((s) => `- "${(s.subject ?? "").slice(0, 80)}" → ${s.to}`)
    .join("\n");

  const system = `你是销售的搭档. 用户刚发了一封邮件. 你的任务是决定**要不要 chime in 一句**.
**绝大多数情况下不要 chime** (返回 skip). chime 的标准是: 你看到一个**具体可观察的问题**, 不 chime 就会让 rep 重复同样的错.
chime 的几种情况:
- 这封 subject 跟最近发过的几乎一样 (差异 < 3 字), 而且发给类似的人
- subject 长度异常 (>14 字 或 <2 字)
- 这封发出去的 lead, 对方在 30 天内已经收到过同 rep 的邮件 (从 recipient 看)
**不要** chime 的情况:
- 一切正常
- subject 风格独特但合理
- 用户在批量发 (高频但都不一样)
返回 JSON, 只能是这两种格式之一:
  {"chime": false}
  {"chime": true, "reason": "<不超过 30 字的中文>"}
不要解释, 不要 markdown, 只要纯 JSON.`;

  const user = `刚发的邮件:
subject: "${ctx.subject}"
to: ${ctx.body_excerpt ? "(收件人内联)" : "?"}

最近 30 封 sent (新到旧):
${recentSubjects || "(无)"}

判断: 要不要 chime?`;

  let chime: { reason: string } | null = null;
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system,
      user,
      temperature: 0.2,
      max_tokens: 120,
      timeoutMs: 8_000,
    });
    const cleaned = r.text.trim().replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned);
    if (parsed?.chime === true && typeof parsed.reason === "string") {
      chime = { reason: parsed.reason.slice(0, 200) };
    }
  } catch {
    // LLM failure is not user-visible — chime stays null. Fail-quiet
    // is right here: a missed chime is much better than a noisy or
    // wrong chime, and we're firing on every send.
  }

  // Only stamp cooldown when we actually chime — silent skips don't
  // burn the budget for the next real chime.
  if (chime) {
    await supabase
      .from("helper_rep_state")
      .upsert(
        {
          rep_id: session.repId,
          last_action_chime_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "rep_id" },
      );
  }

  return NextResponse.json({ chime });
}
