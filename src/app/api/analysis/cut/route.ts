// GET /api/analysis/cut?dim={geo_binary|geo_detail|school_tier|lead_tier|h_index|citations|direction}
//
// Generic cut endpoint — pulls one dimension from computeSegmentFunnels
// and asks the LLM for a 3-5 sentence interpretation. Replaces the
// per-cut endpoint sprawl (geo, direction, …) with one route.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { computeSegmentFunnels } from "@/lib/segment-funnels";
import { llmChat } from "@/lib/llm-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4.6";

const KNOWN_DIMS: Record<string, { label: string; sliceLabel: string }> = {
  geo_binary:   { label: "Domestic .cn vs Overseas",     sliceLabel: "geography" },
  geo_detail:   { label: "By country / domain",          sliceLabel: "geography" },
  school_tier:  { label: "By school tier",               sliceLabel: "school tier" },
  lead_tier:    { label: "By lead tier (strong/normal)", sliceLabel: "lead tier" },
  h_index:      { label: "By author H-index",            sliceLabel: "H-index" },
  citations:    { label: "By citation count",            sliceLabel: "citation count" },
  direction:    { label: "By research direction",        sliceLabel: "research direction" },
  geo_x_school: { label: "Geography × school tier",      sliceLabel: "geo × school" },
};

const SYSTEM = (sliceLabel: string) => `你是 org 的 Chief of Staff. 看了下面按 ${sliceLabel} 切的 click + post-click conversion 数据, 写一段 3-5 句的判断给团队看.

要求:
- 第一句给一个**带立场的总结**
- 接着 2-3 句把最有说服力的对比指出来, 带数字
- 最后一句给一个**具体动作**
- 不要废话

输出严格 JSON: { "summary": string, "biggest_lever": string (≤8 词), "should_pitch_to_congress": boolean }`;

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const dim = url.searchParams.get("dim") ?? "geo_binary";
  if (!KNOWN_DIMS[dim]) {
    return NextResponse.json({ error: `unknown dim: ${dim}. Known: ${Object.keys(KNOWN_DIMS).join(", ")}` }, { status: 400 });
  }
  const meta = KNOWN_DIMS[dim];

  const isAdmin = session.role === "admin";
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
  const dimension = funnels.dimensions.find((d) => d.dimension === dim);

  let summary: { summary: string; biggest_lever: string; should_pitch_to_congress: boolean } | null = null;
  if (dimension && dimension.segments.length > 0) {
    try {
      const out = await llmChat({
        model: MODEL,
        system: SYSTEM(meta.sliceLabel),
        user: JSON.stringify({
          scope: isAdmin ? "admin" : "rep",
          rep_name: session.repName ?? null,
          dim,
          lookback_days: lookbackDays,
          totals: funnels.totals,
          segments: dimension.segments,
        }),
        json: true,
        max_tokens: 700,
        temperature: 0.3,
        timeoutMs: 35_000,
      });
      summary = JSON.parse(out.text);
    } catch (err) {
      console.error("[cut] LLM summary failed", err);
    }
  }

  return NextResponse.json({
    dim,
    label: meta.label,
    slice_label: meta.sliceLabel,
    scope: { repId, lookbackDays, isAdmin },
    totals: funnels.totals,
    segments: dimension?.segments ?? [],
    summary,
    generated_at: new Date().toISOString(),
  });
}
