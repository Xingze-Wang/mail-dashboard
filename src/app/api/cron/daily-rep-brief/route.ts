// /api/cron/daily-rep-brief — runs nightly after insights-prewarm.
// For each active rep, asks an LLM to look at their recent data + the
// already-computed insights cards + their memory + today's missions,
// and write a 1-sentence goal + 2-3 supporting bullets + a reasoning
// paragraph. The /missions page reads this as the "Today" header.
//
// Why this cron exists: the existing insights-prewarm writes structured
// cards (good for analysis) and missions writes per-rep send/reply
// targets (good for action), but there's no narrative tying them
// together — "you've been pushing tier-1 hard, today try X instead, here's
// why". This is that.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";

export const preferredRegion = ["hkg1"];
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4.6";

interface BriefShape {
  goal: string;
  reasoning: string;
  bullets: string[];
}

async function briefForRep(repId: number, repName: string, today: string): Promise<BriefShape | null> {
  // Inputs: today's missions, today's insights card, recent rep activity,
  // rep memory (rep_pref / self_critique). Pull in parallel, hand to LLM.
  const [missionsR, cardsR, activityR, memoryR] = await Promise.all([
    supabase.from("missions")
      .select("kind, target, scope, description, status")
      .eq("rep_id", repId)
      .eq("due_date", today),
    supabase.from("insights_llm_cache")
      .select("payload")
      .eq("rep_id", repId)
      .eq("role_view", "rep")
      .eq("effective_date", today)
      .maybeSingle(),
    supabase.from("emails")
      .select("status, created_at")
      .eq("actor_rep_id", repId)
      .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
      .limit(50),
    supabase.from("helper_learnings")
      .select("kind, body")
      .or(`scope_rep_id.eq.${repId},scope_rep_id.is.null`)
      .in("kind", ["rep_pref", "self_critique"])
      .is("superseded_at", null)
      .limit(10),
  ]);

  const last7d = (activityR.data ?? []).length;
  const sentCount = (activityR.data ?? []).filter((e) => ["sent", "delivered", "opened", "clicked"].includes(String(e.status))).length;

  const userPayload = {
    rep_name: repName,
    today,
    missions_today: missionsR.data ?? [],
    insights_cards: (cardsR.data?.payload as { cards?: unknown[] } | null)?.cards?.slice(0, 3) ?? [],
    last_7d_email_count: last7d,
    last_7d_sent: sentCount,
    rep_memory: (memoryR.data ?? []).map((m) => ({ kind: m.kind, body: m.body.slice(0, 200) })),
  };

  const system = `你是这位 sales rep 的资深 advisor. 看完今天的数据 + insights + 这周的活动, 写一段简短的 "今天的重点".

输出严格 JSON, 不要解释:
{
  "goal": string (一句话, ≤30 字, 用第二人称: "今天聚焦 X" / "今天的关键是 Y"),
  "reasoning": string (2-3 句, 解释为什么是这个目标 — 引用具体数据/insights),
  "bullets": [string] (1-3 条具体战术, 每条 ≤25 字, 都是动作建议, 不是观察)
}

写作规则:
- 用 rep_name, 第二人称
- goal 要**具体到可执行**, 不要 "做好你的工作"; 要 "今天清完 cn-tier1 的 12 条 ready" 这种
- reasoning 引用 missions + insights_cards 里的具体数字 / 短语
- bullets 是战术 (e.g. "subject 用 6 词以内", "周三 8 点发效果最好"), 不是目标
- 如果数据不够 / 这个 rep 今天没什么特别要做的 — 老实写 "今天数据正常, 按常规节奏跑就行" 之类, 不要硬编 insights

注意: 这是 rep 早上第一眼看的, 要**信号高 + 短**. 不要废话.`;

  try {
    const r = await llmChat({
      model: MODEL,
      system,
      user: JSON.stringify(userPayload),
      json: true,
      max_tokens: 600,
      temperature: 0.4,
      timeoutMs: 45_000,
    });
    let cleaned = r.text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
    const j = JSON.parse(cleaned);
    if (typeof j.goal !== "string" || typeof j.reasoning !== "string" || !Array.isArray(j.bullets)) return null;
    return {
      goal: j.goal.slice(0, 200),
      reasoning: j.reasoning.slice(0, 600),
      bullets: j.bullets.map((b: unknown) => String(b).slice(0, 200)).filter(Boolean).slice(0, 5),
    };
  } catch (err) {
    console.error(`[daily-rep-brief] LLM failed for rep ${repId}:`, err);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const t0 = Date.now();

  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, role")
    .eq("active", true)
    .in("role", ["sales", "senior", "admin"]);

  const results: Array<{ rep_id: number; ok: boolean; error?: string }> = [];
  for (const r of reps ?? []) {
    try {
      const brief = await briefForRep(r.id, r.name, today);
      if (!brief) {
        results.push({ rep_id: r.id, ok: false, error: "LLM failed or returned invalid shape" });
        continue;
      }
      // Upsert — admin_overrode rows are preserved (don't clobber admin's edits)
      const { data: existing } = await supabase
        .from("daily_rep_brief")
        .select("id, admin_overrode")
        .eq("rep_id", r.id)
        .eq("brief_date", today)
        .maybeSingle();
      if (existing?.admin_overrode) {
        results.push({ rep_id: r.id, ok: true, error: "admin_overrode — kept admin edit" });
        continue;
      }
      if (existing) {
        await supabase.from("daily_rep_brief").update({
          goal: brief.goal,
          reasoning: brief.reasoning,
          bullets: brief.bullets,
          decision_model: MODEL,
          computed_at: new Date().toISOString(),
        }).eq("id", existing.id);
      } else {
        await supabase.from("daily_rep_brief").insert({
          rep_id: r.id,
          brief_date: today,
          goal: brief.goal,
          reasoning: brief.reasoning,
          bullets: brief.bullets,
          decision_model: MODEL,
        });
      }
      results.push({ rep_id: r.id, ok: true });
    } catch (err) {
      results.push({ rep_id: r.id, ok: false, error: String(err).slice(0, 200) });
    }
  }
  return NextResponse.json({
    ran_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    reps_processed: results.length,
    failures: results.filter((r) => !r.ok).length,
    results,
  });
}
