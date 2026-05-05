// GET /api/analysis/geo — full geography breakdown for the /analysis/geo page.
// Returns the geo_binary, geo_detail, and geo_x_school dimensions from the
// existing segment-funnels engine, plus a bot-written summary.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { computeSegmentFunnels } from "@/lib/segment-funnels";
import { llmChat } from "@/lib/llm-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4.6";

const SYSTEM = `你是 org 的 Chief of Staff. 看了下面的 geography 数据 (domestic .cn vs 海外, 加上 detailed 国家拆分和 school tier × geo 交叉), 你的任务是写一段 3-5 句的判断给团队看.

要求:
- 第一句给一个**带立场的总结** (e.g. "海外是这季度最大的漏点", "国内 Tier-1 vs Tier-2 差异比 .cn vs 海外更值得关注")
- 接着 2-3 句把最有说服力的对比指出来, 带数字
- 最后一句给一个**具体动作** (改 prompt / 跑 A/B / 给 Congress 提议 / 找 X rep 看)
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
  const geoBinary = funnels.dimensions.find((d) => d.dimension === "geo_binary");
  const geoDetail = funnels.dimensions.find((d) => d.dimension === "geo_detail");
  const geoXSchool = funnels.dimensions.find((d) => d.dimension === "geo_x_school");

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
        geo_binary: geoBinary?.segments ?? [],
        geo_detail: geoDetail?.segments ?? [],
        geo_x_school: geoXSchool?.segments ?? [],
      }),
      json: true,
      max_tokens: 700,
      temperature: 0.3,
      timeoutMs: 35_000,
    });
    summary = JSON.parse(out.text);
  } catch (err) {
    console.error("[geo] LLM summary failed", err);
  }

  return NextResponse.json({
    scope: { repId, lookbackDays, isAdmin },
    totals: funnels.totals,
    geoBinary: geoBinary?.segments ?? [],
    geoDetail: geoDetail?.segments ?? [],
    geoXSchool: geoXSchool?.segments ?? [],
    summary,
    generated_at: new Date().toISOString(),
  });
}
