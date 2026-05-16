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
  domestic: { delivered: number; clicked: number; wechat: number; registered: number; submitted: number; ctr: number; postClickConv: number };
  overseas: { delivered: number; clicked: number; wechat: number; registered: number; submitted: number; ctr: number; postClickConv: number };
  /** ratio of overseas CTR to domestic CTR; >1 means overseas clicks more */
  ctr_ratio: number;
  /** ratio of domestic post-click conv to overseas post-click conv; >1 means domestic converts more once clicked */
  conv_ratio: number;
};

/**
 * Org-/rep-wide MP signal trio (registered / submitted / wechat) over the
 * same lookback window funnels use. Surfaced on the /analysis Hero so the
 * trio shows alongside the weekly headline number.
 */
export type MpSignalTrio = {
  registered: number;
  submitted: number;
  addedWechat: number;
  totalEmailed: number;
};

export type InsightsPayload = {
  scope: "rep" | "admin";
  rep_name: string | null;
  headline: { value: number; label: string; delta?: number; period: string };
  /**
   * MP signal trio over the funnel lookback window (90d). Optional so
   * cached payloads written before the wire-in still render — the page
   * falls back to single-stat headline when absent.
   */
  mp_signals?: MpSignalTrio | null;
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
      domestic: { delivered: dom.delivered, clicked: dom.clicked, wechat: dom.wechat, registered: dom.registered, submitted: dom.submitted, ctr: dom.ctr, postClickConv: dom.postClickConv },
      overseas: { delivered: ovs.delivered, clicked: ovs.clicked, wechat: ovs.wechat, registered: ovs.registered, submitted: ovs.submitted, ctr: ovs.ctr, postClickConv: ovs.postClickConv },
      ctr_ratio: Number(ctrRatio.toFixed(2)),
      conv_ratio: Number(convRatio.toFixed(2)),
    };
  } catch (err) {
    console.error("[insights] geo split failed", err);
    return null;
  }
}

// Compute compact summaries of the OTHER dimensions so the LLM can
// write cards about lead_tier / school_tier / h_index / direction.
// User reported "no normal/strong lead data on insights page" — the
// root cause was that only geo_binary made it into the LLM's
// userPayload (Bug #1 from E2E test). Computing all once and passing
// segment-level CTR + post-click is what unlocks those cards.
async function computeAllDimensionSplits(repId: number | null): Promise<{
  splits: Record<string, Array<{ segment: string; delivered: number; clicked: number; wechat: number; registered: number; submitted: number; ctr: number; postClickConv: number }>>;
  mpSignals: MpSignalTrio | null;
}> {
  try {
    const f = await computeSegmentFunnels({ repId, lookbackDays: 90 });
    const out: Record<string, Array<{ segment: string; delivered: number; clicked: number; wechat: number; registered: number; submitted: number; ctr: number; postClickConv: number }>> = {};
    for (const d of f.dimensions) {
      // Skip the noisy "(no lead data)" bucket from the LLM's view —
      // the cards should talk about real signals only. Same with
      // ultra-fine geo_detail (~50 country buckets).
      if (d.dimension === "geo_detail") continue;
      out[d.dimension] = d.segments
        .filter((s) => s.segment !== "(no lead data)" && s.segment !== "(unknown)")
        .slice(0, 12)
        .map((s) => ({
          segment: s.segment,
          delivered: s.delivered,
          clicked: s.clicked,
          wechat: s.wechat,
          registered: s.registered,
          submitted: s.submitted,
          ctr: Number(s.ctr.toFixed(3)),
          postClickConv: Number(s.postClickConv.toFixed(3)),
        }));
    }
    const mpSignals: MpSignalTrio = {
      registered: f.totals.registered,
      submitted: f.totals.submitted,
      addedWechat: f.totals.wechat,
      totalEmailed: f.totals.delivered,
    };
    return { splits: out, mpSignals };
  } catch (err) {
    console.error("[insights] all-dim splits failed", err);
    return { splits: {}, mpSignals: null };
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

segment_splits 包含其他切片: lead_tier (strong / normal — 哪类 lead 在转化), school_tier (Tier 1/2/3 学校的差异), h_index (作者引用量段), citations, direction (研究方向). 这些是 rep 真正在意的: "我邮件大部分发到 Tier 1, 但 Tier 2 转化更高" 是非常值得做卡的洞察. 主动从 segment_splits 里挖一两条最反直觉/最 actionable 的, 写成卡.

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

// Daily cache layer (mig 077). The /analysis page reads from this
// table on every visit so the LLM call doesn't happen interactively.
// The 06:15 UTC cron pre-warms it for every rep before they log in.
// Cache miss falls through to live compute + write-through.
async function readCache(scope: "rep" | "admin", repId: number | null): Promise<InsightsPayload | null> {
  const { supabase } = await import("@/lib/db");
  const today = new Date().toISOString().slice(0, 10);
  let q = supabase
    .from("insights_llm_cache")
    .select("payload")
    .eq("role_view", scope)
    .eq("effective_date", today);
  // Two partial indexes (mig 077): one for NULL rep_id, one for non-null.
  // .is() vs .eq() picks the right one.
  q = repId === null ? q.is("rep_id", null) : q.eq("rep_id", repId);
  const { data, error } = await q.maybeSingle();
  if (error || !data) return null;
  return data.payload as InsightsPayload;
}

async function writeCache(
  scope: "rep" | "admin",
  repId: number | null,
  payload: InsightsPayload,
  decidedBy: "cron" | "live" | "admin",
): Promise<void> {
  try {
    const { supabase } = await import("@/lib/db");
    const today = new Date().toISOString().slice(0, 10);
    // upsert on the two partial indexes — we have to do existence-check
    // + branch insert/update because Postgres can't ON CONFLICT a
    // partial index target. Same pattern as the insights-realign cron
    // (mig 075 → 6a1592d).
    let existing = supabase
      .from("insights_llm_cache")
      .select("id")
      .eq("role_view", scope)
      .eq("effective_date", today);
    existing = repId === null ? existing.is("rep_id", null) : existing.eq("rep_id", repId);
    const { data: hit } = await existing.maybeSingle();
    if (hit) {
      await supabase.from("insights_llm_cache").update({
        payload,
        computed_at: new Date().toISOString(),
        decided_by: decidedBy,
        decision_model: MODEL,
      }).eq("id", hit.id);
    } else {
      await supabase.from("insights_llm_cache").insert({
        rep_id: repId,
        role_view: scope,
        payload,
        decided_by: decidedBy,
        decision_model: MODEL,
        effective_date: today,
      });
    }
  } catch (err) {
    // Cache write is best-effort — never block the response on it.
    console.error("[insights] cache write-through failed", err);
  }
}

/**
 * The actual compute. Extracted so it can be called both from the
 * interactive GET (cache miss) and from the daily prewarm cron.
 *
 * Sparkline + geo + LLM all live here. Returns the same payload
 * shape we eventually send to the client.
 */
export async function computeInsightsPayload(args: {
  repId: number;
  repName: string | null;
  role: "admin" | "senior" | "sales";
}): Promise<InsightsPayload> {
  const { repId, repName, role } = args;
  const isAdmin = role === "admin";
  const scope: "rep" | "admin" = isAdmin ? "admin" : "rep";

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
    repId,
    role,
    repName: repName ?? undefined,
    email: undefined,
  };

  const toolResults = await Promise.all(calls.map((c) => runReadTool(sessionLite, c).catch((err) => ({ tool: c.tool, result: { error: String(err) } }))));

  const memTool = toolResults.find((t) => t.tool === "get_my_memory");
  const memArr = (asObj(memTool?.result).memory as Array<{ kind: string; body: string }>) ?? [];
  const prefs = extractInsightsPrefs(memArr);

  const [weekly, geoSplit, allDimResult] = await Promise.all([
    isAdmin ? getWeeklyConversionsOrgWide(8) : getWeeklyConversionsForRep(repId, 8),
    computeGeoSplit(isAdmin ? null : repId),
    computeAllDimensionSplits(isAdmin ? null : repId),
  ]);
  const allDimSplits = allDimResult.splits;
  const mpSignals = allDimResult.mpSignals;
  const sparkline = buildSparkline(weekly);
  const lastTwo = sparkline.slice(-2);
  const thisWeek = lastTwo[1] ?? 0;
  const lastWeek = lastTwo[0] ?? 0;
  const delta = thisWeek - lastWeek;

  const userPayload = {
    scope,
    rep_name: repName ?? null,
    rep_role: role,
    today: new Date().toISOString().slice(0, 10),
    user_preferences_for_insights: prefs,
    headline_metric: { this_week_conversions: thisWeek, last_week_conversions: lastWeek, delta },
    weekly_history: weekly,
    geo_split: geoSplit,
    // MP signal trio over the same lookback (90d): registered (MP-known),
    // submitted (filled the application — the actual conversion), and
    // addedWechat (warm touch). Use these to write cards about WHERE
    // recipients are stalling in the funnel: many registered + few
    // submitted = pitch is losing them after sign-up; few registered =
    // top of funnel is leaky.
    mp_signals: mpSignals,
    // Per-dimension funnel data — lead_tier (strong/normal), school_tier
    // (Tier 1/2/3), h_index buckets, citation buckets, direction. Each
    // segment now also carries registered/submitted alongside wechat so
    // the LLM can call out "Tier 1 registers a lot but doesn't submit".
    segment_splits: allDimSplits,
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
      timeoutMs: 60_000,                         // was 45s — observed
                                                  // 50-70s typical for the
                                                  // bigger admin payloads.
    });
    // Models sometimes wrap JSON in ```json fences even with json:true
    // mode set. Strip them defensively — congress-runners.ts uses the
    // same regex on synth output. Then fix common JSON malformations
    // the model occasionally emits (trailing comma before } or ]).
    let cleaned = out.text.trim()
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");  // trailing-comma fix
    parsed = JSON.parse(cleaned) as LlmShape;
  } catch (err) {
    console.error("[insights] LLM call failed — parsed=null, caller can decide whether to cache", err);
  }

  const payload: InsightsPayload = {
    scope,
    rep_name: repName ?? null,
    headline: {
      value: thisWeek,
      label: parsed?.headline_label ?? (scope === "admin" ? "Org WeChat conversions" : "Your conversions"),
      delta,
      period: "this week",
    },
    mp_signals: mpSignals,
    sparkline,
    intro: parsed?.intro ?? FALLBACK.intro,
    cards: parsed?.cards ?? FALLBACK.cards,
    geo_split: geoSplit,
    prefs_seen: prefs,
    generated_at: new Date().toISOString(),
  };
  // Tag the payload with whether the LLM half succeeded — callers
  // (prewarm cron, interactive write-through) check this before
  // persisting. Caching a 0-cards FALLBACK is worse than no cache:
  // the page would read it and render empty instead of falling
  // through to live recompute, which might succeed on retry.
  (payload as InsightsPayload & { _llm_ok: boolean })._llm_ok = parsed !== null;
  return payload;
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isAdmin = session.role === "admin";
  const scope: "rep" | "admin" = isAdmin ? "admin" : "rep";
  // Admins read the org-wide row (rep_id NULL); non-admins read their own.
  const cacheRepId = isAdmin ? null : session.repId;

  // Cache-first. If today's row exists, the user gets sub-100ms.
  const cached = await readCache(scope, cacheRepId);
  if (cached) {
    return NextResponse.json({ ...cached, _cache: "hit" });
  }

  // Cache miss → live compute. This is the slow path (5-15s) but
  // ALSO writes the cache so the next visitor that day is fast.
  // The daily prewarm cron should make this rare in practice.
  const payload = await computeInsightsPayload({
    repId: session.repId,
    repName: session.repName ?? null,
    role: session.role,
  });

  // Only cache LLM-successful rows. A 0-cards FALLBACK in the cache
  // means tomorrow's visitor sees empty cards forever; better to
  // re-attempt live compute on the next visit.
  const llmOk = (payload as InsightsPayload & { _llm_ok?: boolean })._llm_ok !== false;
  if (llmOk) {
    writeCache(scope, cacheRepId, payload, "live").catch(() => {});
  }

  // Strip the internal _llm_ok flag before returning to client.
  const { _llm_ok: _omit, ...clientPayload } = payload as InsightsPayload & { _llm_ok?: boolean };
  void _omit;
  return NextResponse.json({ ...clientPayload, _cache: llmOk ? "miss" : "miss-llm-failed" });
}
