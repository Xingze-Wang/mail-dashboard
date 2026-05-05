// GET /api/insights — bot-curated insights page.
// One LLM call gathers helper-tool primitives, applies the user's saved
// preferences, and returns a structured page spec the client renders.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { runReadTool } from "@/lib/helper-read-tools";
import { llmChat } from "@/lib/llm-proxy";
import { computeSegmentFunnels } from "@/lib/segment-funnels";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4.6";

export type InsightCard = {
  kind: "metric" | "alert" | "winner" | "leak" | "note";
  title: string;
  body: string;
  evidence?: { label: string; value: string | number }[];
  action?: { label: string; href: string };
  severity?: "info" | "warn" | "high";
};

export type GeoSplit = {
  domestic: { delivered: number; clicked: number; wechat: number; ctr: number; postClickConv: number };
  overseas: { delivered: number; clicked: number; wechat: number; ctr: number; postClickConv: number };
  /** ratio of overseas CTR to domestic CTR; >1 means overseas clicks more */
  ctr_ratio: number;
  /** ratio of domestic post-click conv to overseas post-click conv; >1 means domestic converts more once clicked */
  conv_ratio: number;
};

export type InsightsPayload = {
  scope: "rep" | "admin";
  rep_name: string | null;
  headline: { value: number; label: string; delta?: number; period: string };
  sparkline: number[];
  intro: string;
  cards: InsightCard[];
  geo_split: GeoSplit | null;
  prefs_seen: string[];
  generated_at: string;
};

const FALLBACK: Omit<InsightsPayload, "scope" | "rep_name" | "generated_at" | "geo_split"> = {
  headline: { value: 0, label: "Conversions", period: "this week" },
  sparkline: [],
  intro: "Not enough recent activity to surface anything actionable. Send a few emails or wait for new data.",
  cards: [],
  prefs_seen: [],
};

async function computeGeoSplit(repId: number | null): Promise<GeoSplit | null> {
  try {
    const f = await computeSegmentFunnels({ repId, lookbackDays: 90 });
    const dim = f.dimensions.find((d) => d.dimension === "geo_binary");
    if (!dim) return null;
    const dom = dim.segments.find((s) => s.segment === "Domestic (.cn)");
    const ovs = dim.segments.find((s) => s.segment === "Overseas");
    if (!dom || !ovs) return null;
    const ctrRatio = dom.ctr > 0 ? ovs.ctr / dom.ctr : 0;
    const convRatio = ovs.postClickConv > 0 ? dom.postClickConv / ovs.postClickConv : 0;
    return {
      domestic: { delivered: dom.delivered, clicked: dom.clicked, wechat: dom.wechat, ctr: dom.ctr, postClickConv: dom.postClickConv },
      overseas: { delivered: ovs.delivered, clicked: ovs.clicked, wechat: ovs.wechat, ctr: ovs.ctr, postClickConv: ovs.postClickConv },
      ctr_ratio: Number(ctrRatio.toFixed(2)),
      conv_ratio: Number(convRatio.toFixed(2)),
    };
  } catch (err) {
    console.error("[insights] geo split failed", err);
    return null;
  }
}

function asObj(x: unknown): Record<string, unknown> {
  return typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
}

function buildSparkline(weekly: { week: number; conversions: number }[]): number[] {
  const last8 = weekly.slice(-8);
  return last8.map((w) => w.conversions);
}

async function getWeeklyConversionsForRep(repId: number, weeks = 8): Promise<{ week: number; conversions: number }[]> {
  const { supabase } = await import("@/lib/db");
  const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("brief_lookups")
    .select("wechat_at")
    .eq("added_wechat", true)
    .eq("marked_by_rep_id", repId)
    .gte("wechat_at", since);
  const buckets = new Map<number, number>();
  for (const row of data ?? []) {
    const t = new Date(row.wechat_at as string).getTime();
    const bucketWeek = Math.floor(t / (7 * 86_400_000));
    buckets.set(bucketWeek, (buckets.get(bucketWeek) ?? 0) + 1);
  }
  const out: { week: number; conversions: number }[] = [];
  const nowBucket = Math.floor(Date.now() / (7 * 86_400_000));
  for (let i = weeks - 1; i >= 0; i--) {
    const w = nowBucket - i;
    out.push({ week: w, conversions: buckets.get(w) ?? 0 });
  }
  return out;
}

async function getWeeklyConversionsOrgWide(weeks = 8): Promise<{ week: number; conversions: number }[]> {
  const { supabase } = await import("@/lib/db");
  const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("brief_lookups")
    .select("wechat_at")
    .eq("added_wechat", true)
    .gte("wechat_at", since);
  const buckets = new Map<number, number>();
  for (const row of data ?? []) {
    const t = new Date(row.wechat_at as string).getTime();
    const bucketWeek = Math.floor(t / (7 * 86_400_000));
    buckets.set(bucketWeek, (buckets.get(bucketWeek) ?? 0) + 1);
  }
  const out: { week: number; conversions: number }[] = [];
  const nowBucket = Math.floor(Date.now() / (7 * 86_400_000));
  for (let i = weeks - 1; i >= 0; i--) {
    const w = nowBucket - i;
    out.push({ week: w, conversions: buckets.get(w) ?? 0 });
  }
  return out;
}

function extractInsightsPrefs(memory: Array<{ kind: string; body: string }>): string[] {
  return memory
    .filter((m) => /^insights:/i.test(m.body) || m.kind === "insights_pref")
    .map((m) => m.body.replace(/^insights:\s*/i, ""));
}

const SYSTEM_REP = `你是这位销售 rep 的资深 advisor. 你看完所有数据后, 写一份 ≤3 卡的 Insights 页, 像一个老师傅在跟徒弟说 "今天最值得你看的就这几件事".

输入: helper-bot 的真实数据 (recap, growth, memory, wechat followups, geo_split, weekly_history).
输出: 一段 intro paragraph (你的 take) + 2-3 张卡 (每张都是一个**判断 + 证据 + 下一步**).

写卡的标准:
- 不要客观陈述事实, 要**有立场**: "你这周的 Tier-1 投递在掉, 我猜是 subject 太长" 比 "Tier-1 投递率 X%" 强 10 倍
- 每张卡的 body 必须包含 (a) 一个具体观察 (b) 一个解释或猜测 (c) 一个动作建议
- evidence 是数字, body 是判断
- 用 rep_name, 用具体的 lead title / 数字, 不要 "建议关注"
- 用 user_preferences_for_insights 决定哪些主题进/出 (memory 里 insights: 前缀的条目)

geo_split (CN .cn vs 海外) 是这个产品最重要的切片之一. 你应该**主动判断**它对这个 rep 现在重不重要 (新人 vs 老 rep, 国内主导 vs 海外主导, 上周 vs 90 天). 如果重要, 把它做成一张带强观点的卡 ("你海外样本只有 12, 别下结论" 也是合理的卡). 不要因为它是默认数据就生搬硬套.

返回严格 JSON, schema:
{
  "intro": string (≤2 句, 你的整体判断),
  "headline_label": string ("This week" / "本周" / "Past 7 days" 之类),
  "cards": [
    {
      "kind": "metric" | "alert" | "winner" | "leak" | "note",
      "title": string (≤6 词, 一个 claim 不是一个分类标签),
      "body": string (1-2 句, 带数字 + 判断 + 动作),
      "evidence": [{"label": string, "value": string}] (最多 3 条原始数字),
      "action": {"label": string, "href": string} (指向 /pipeline / /emails / /congress 等),
      "severity": "info" | "warn" | "high"
    }
  ]
}`;

const SYSTEM_ADMIN = `你是 org 的 Chief of Staff. 看完今天的数据, 你要给 admin 一份 ≤3 卡的简报 — 不是把 alerts 复述一遍, 而是**告诉 admin 现在最该想什么、做什么**.

输入: getAdminAlerts (raw), org weekly_history, geo_split, recap.
输出: 一段 intro (你的整体判断) + 2-3 张卡 (每张是一个 pitch).

每张卡像一个 1-page memo:
- title 是结论 ("Overseas leak is the biggest fix on the table" 不是 "Geo Comparison")
- body 给判断 + 证据 + 下一步 (admin 该 ping 谁 / 看哪个页面 / 改什么 prompt)
- 不要四平八稳, 把最值得 admin 注意的事**摆在第一张卡**, 直说为什么
- alerts 只是原料; 你的工作是 frame 它. 一个 click_drop alert + geo_split 数据 + 一个 idle rep 可能合成一张 "这周海外投递质量在掉, X 还没回应" 的卡, 比三张独立卡强

geo_split 是 org 最关键的切片之一. 如果数据足够, 你应该**主动 pitch** 它: 它是不是这周变了? 它是不是某个 rep 的问题? 是不是某个 segment 的问题? 是不是 Congress 该看的? 给 admin 一个具体的判断 + action.

如果你判断某个洞察值得提交给 weekly Tactical Congress, 在 action 里给 href: "/congress" 并在 body 提一句 "建议带到 Congress 这周讨论".

返回严格 JSON, schema 跟 rep view 一样.`;

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isAdmin = session.role === "admin";
  const scope: "rep" | "admin" = isAdmin ? "admin" : "rep";

  // Gather primitives in parallel via the existing helper read tools.
  const calls = isAdmin
    ? [
        { tool: "get_admin_alerts", args: {} },
        { tool: "get_my_memory", args: { limit: 30 } },
        { tool: "get_my_weekly_recap", args: {} },
      ]
    : [
        { tool: "get_my_weekly_recap", args: {} },
        { tool: "get_my_growth", args: {} },
        { tool: "get_my_memory", args: { limit: 30 } },
        { tool: "get_wechat_followups", args: {} },
      ];

  const sessionLite = {
    repId: session.repId,
    role: session.role,
    repName: session.repName,
    email: session.email,
  };

  const toolResults = await Promise.all(calls.map((c) => runReadTool(sessionLite, c).catch((err) => ({ tool: c.tool, result: { error: String(err) } }))));

  // Pull memory entries that are insights prefs.
  const memTool = toolResults.find((t) => t.tool === "get_my_memory");
  const memArr = (asObj(memTool?.result).memory as Array<{ kind: string; body: string }>) ?? [];
  const prefs = extractInsightsPrefs(memArr);

  // Sparkline + headline + geo split come from DB, not LLM (cheap, deterministic).
  const [weekly, geoSplit] = await Promise.all([
    isAdmin
      ? getWeeklyConversionsOrgWide(8)
      : getWeeklyConversionsForRep(session.repId, 8),
    computeGeoSplit(isAdmin ? null : session.repId),
  ]);
  const sparkline = buildSparkline(weekly);
  const lastTwo = sparkline.slice(-2);
  const thisWeek = lastTwo[1] ?? 0;
  const lastWeek = lastTwo[0] ?? 0;
  const delta = thisWeek - lastWeek;

  // Build LLM prompt.
  const userPayload = {
    scope,
    rep_name: session.repName ?? null,
    rep_role: session.role,
    today: new Date().toISOString().slice(0, 10),
    user_preferences_for_insights: prefs,
    headline_metric: { this_week_conversions: thisWeek, last_week_conversions: lastWeek, delta },
    weekly_history: weekly,
    geo_split: geoSplit,
    primitives: Object.fromEntries(toolResults.map((t) => [t.tool, t.result])),
  };

  type LlmShape = { intro: string; headline_label: string; cards: InsightCard[] };
  let parsed: LlmShape | null = null;
  try {
    const out = await llmChat({
      model: MODEL,
      system: scope === "rep" ? SYSTEM_REP : SYSTEM_ADMIN,
      user: JSON.stringify(userPayload),
      json: true,
      max_tokens: 1500,
      temperature: 0.3,
      timeoutMs: 45_000,
    });
    parsed = JSON.parse(out.text) as LlmShape;
  } catch (err) {
    console.error("[insights] LLM call failed", err);
  }

  const payload: InsightsPayload = {
    scope,
    rep_name: session.repName ?? null,
    headline: {
      value: thisWeek,
      label: parsed?.headline_label ?? (scope === "admin" ? "Org WeChat conversions" : "Your conversions"),
      delta,
      period: "this week",
    },
    sparkline,
    intro: parsed?.intro ?? FALLBACK.intro,
    cards: parsed?.cards ?? FALLBACK.cards,
    geo_split: geoSplit,
    prefs_seen: prefs,
    generated_at: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
