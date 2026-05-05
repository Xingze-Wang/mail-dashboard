// GET /api/analysis/direction — research-direction breakdown.
// Same shape as /api/analysis/geo but slices on the `direction` dimension.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { computeSegmentFunnels } from "@/lib/segment-funnels";
import { llmChat } from "@/lib/llm-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4.6";

const SYSTEM = `你是 org 的 Chief of Staff. 看了下面的 research-direction 数据 (按方向切的 click 和 conversion), 写一段 3-5 句的判断给团队看.

要求:
- 第一句给一个**带立场的总结** (e.g. "3D Vision 是这季度最好的方向", "LLM Architecture click 高但 conv 低")
- 接着 2-3 句把最有说服力的对比指出来, 带数字
- 最后一句给一个**具体动作** (调整 segment 重点 / 改 prompt / 给 Congress 提议 / 找 X rep)
- 不要说 "建议关注" "需要进一步分析" 这种废话

输出严格 JSON: { "summary": string, "biggest_lever": string (≤8 词的 takeaway), "should_pitch_to_congress": boolean }`;

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isAdmin = session.role === "admin";
  const url = new URL(req.url);
  const repIdParam = url.searchParams.get("repId");
  const daysParam = url.searchParams.get("days");

  let repId: number | null = null;
  if (isAdmin && repIdParam && repIdParam !== "all") {
    const n = Number(repIdParam);
    if (Number.isFinite(n)) repId = n;
  } else if (!isAdmin) {
    repId = session.repId;
  }
  const lookbackDays = daysParam ? Math.max(7, Math.min(365, Number(daysParam) || 90)) : 90;

  const funnels = await computeSegmentFunnels({ repId, lookbackDays });
  const direction = funnels.dimensions.find((d) => d.dimension === "direction");

  let summary: { summary: string; biggest_lever: string; should_pitch_to_congress: boolean } | null = null;
  try {
    const out = await llmChat({
      model: MODEL,
      system: SYSTEM,
      user: JSON.stringify({
        scope: isAdmin ? "admin" : "rep",
        rep_name: session.repName ?? null,
        lookback_days: lookbackDays,
        totals: funnels.totals,
        direction: direction?.segments ?? [],
      }),
      json: true,
      max_tokens: 700,
      temperature: 0.3,
      timeoutMs: 35_000,
    });
    summary = JSON.parse(out.text);
  } catch (err) {
    console.error("[direction] LLM summary failed", err);
  }

  return NextResponse.json({
    scope: { repId, lookbackDays, isAdmin },
    totals: funnels.totals,
    direction: direction?.segments ?? [],
    summary,
    generated_at: new Date().toISOString(),
  });
}
