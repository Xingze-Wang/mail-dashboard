import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getEffectiveQuota } from "@/lib/quota-store";
import { sumPerPool } from "@/lib/pool-types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/missions/heuristic-seed
 *
 * Seeds today's missions based on each rep's queue depth. Used as a
 * "v0 something to do" generator until weekly congress takes over
 * the per-rep mission generation.
 *
 * Logic per rep:
 *   - Count `ready` leads in their queue.
 *   - send target = clamp(ready_count, 5, 12). i.e. always at least 5
 *     to keep momentum, never more than 12 to avoid burnout.
 *   - Count unread inbounds tied to this rep's leads (proxy via
 *     emails.actor_rep_id since CLAUDE.md says actor=who sent).
 *   - reply target = unread_inbounds (capped at 5).
 *   - mark_wechat target = 0 (admin/manual; not generated heuristically).
 *
 * Idempotency: if today already has heuristic missions for this rep,
 * skip them. Won't ever overwrite congress-generated missions.
 *
 * Auth: admin only (this is a one-shot seed; not for sales).
 */

async function notifyAdminMissingQuota(rep: { id: number; name: string }): Promise<void> {
  const ADMIN_OPEN_ID = process.env.ADMIN_LARK_OPEN_ID;
  if (!ADMIN_OPEN_ID) return;
  try {
    const { sendMessage } = await import("@/lib/lark");
    await sendMessage({
      receive_id: ADMIN_OPEN_ID,
      receive_id_type: "open_id",
      text: `⚠️ ${rep.name} 今天没有 daily quota — 我跳过了 mission seed. 去 /admin/missions 设一下.`,
    });
  } catch {
    /* silent — DM failure shouldn't break the seed */
  }
}

// Dedup notifications within a single cron invocation.
// (Cron runs once per day so cross-invocation dedup isn't needed.)
const notifiedThisRun = new Set<number>();

async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface SeedResult {
  rep_id: number;
  rep_name: string;
  send_target: number;
  reply_target: number;
  skipped_reason?: string;
  skipped_send_reason?: string;
}

/**
 * Build a personalized "experiment" mission for a rep, surfacing their
 * strongest segment vs org baseline so they can double-down where
 * they're already winning. Only fires Mondays (weekly cadence).
 * Returns null if the rep doesn't have enough signal (<20 sends in 30d)
 * — better no experiment mission than a noisy one.
 *
 * Decision: pick the segment with the largest positive (rep CTR − org CTR)
 * delta, with ≥5 rep-side sends so we're not surfacing a 1-clicked-1-sent
 * fluke. Cap at 1 experiment mission per rep per Monday.
 */
async function buildExperimentMission(
  repId: number,
  repName: string,
): Promise<{ target: number; scope: Record<string, unknown>; description: string } | null> {
  // Pull rep's 30d sends + their CTR per geo_binary + per direction.
  // Cheap enough to call segment-funnels with repId filter; it caches.
  const { computeSegmentFunnels } = await import("@/lib/segment-funnels");
  const repFunnel = await computeSegmentFunnels({ repId, lookbackDays: 30 });
  if (repFunnel.totals.delivered < 20) return null;          // need signal

  const orgFunnel = await computeSegmentFunnels({ repId: null, lookbackDays: 30 });
  const orgCtr = orgFunnel.totals.delivered > 0
    ? orgFunnel.totals.clicked / orgFunnel.totals.delivered : 0.2;

  // Combine geo_binary + direction segments. Each gets a (delta, n)
  // tuple; we pick the best (delta) with n ≥ 5.
  type Candidate = { dimension: string; segment: string; delta: number; ctr: number; n: number };
  const candidates: Candidate[] = [];
  for (const dim of repFunnel.dimensions) {
    if (dim.dimension !== "geo_binary" && dim.dimension !== "direction" && dim.dimension !== "school_tier") continue;
    for (const seg of dim.segments) {
      // Bumped from n≥5 to n≥10 — at n=5 the CTR estimate has a ±15pp
      // standard error, so the "delta" is dominated by noise. n=10
      // keeps the bar reasonable for early-cohort reps.
      if (seg.delivered < 10) continue;
      if (seg.segment === "(no lead data)" || seg.segment === "(unknown)") continue;
      candidates.push({
        dimension: dim.dimension,
        segment: seg.segment,
        delta: seg.ctr - orgCtr,
        ctr: seg.ctr,
        n: seg.delivered,
      });
    }
  }

  // Fallback "explore" mission if no candidate has a meaningful delta.
  // Better than silently dropping the qualitative mission for the rep —
  // gives them a learning prompt instead of nothing.
  if (candidates.length === 0 || candidates.sort((a, b) => b.delta - a.delta)[0].delta < 0.03) {
    return {
      target: 5,
      scope: { kind: "explore", lookback_days: 30 },
      description: [
        `**本周探索** (${repName}): 你的 30 天数据还没显示出明显的强项 — 没问题, 我们用本周来找.`,
        ``,
        `**任务**: 本周从你 queue 里挑 5 条 lead, 选**跟你之前发过的不一样**的 — 不同 geo, 不同 school tier, 不同方向. 然后告诉 Leon "这周我试了 X 类", 让他帮你 track.`,
        ``,
        `(目的: 给你的 funnel 增加 segment diversity, 这样下周我们就能给你一个有针对性的 experiment 了.)`,
      ].join("\n"),
    };
  }

  const winner = candidates[0];

  // Translate dimension to natural-language ask + a target N. Target
  // scales with how strong the signal is — bigger delta → bigger push.
  const target = winner.delta >= 0.10 ? 15 : winner.delta >= 0.05 ? 10 : 6;
  const dimLabel =
    winner.dimension === "geo_binary" ? "geo" :
    winner.dimension === "direction" ? "方向" :
    winner.dimension === "school_tier" ? "school tier" :
    winner.dimension;

  const description = [
    `**本周实验** (${repName}): 你在 ${winner.segment} 这个 ${dimLabel} 上 CTR ${(winner.ctr * 100).toFixed(0)}%, 比 org 平均 (${(orgCtr * 100).toFixed(0)}%) 高 ${(winner.delta * 100).toFixed(0)}pp.`,
    ``,
    `**任务**: 本周从 ${winner.segment} 多发 ${target} 封, 让样本 N 再大一点 — 这是你的强项, 我们用你来验证.`,
    ``,
    `(数据来自过去 30 天 ${winner.n} 个 sample. delta 来自 segment-funnels.ts. cron 每周一早上 10 点 Beijing 重算.)`,
  ].join("\n");

  return {
    target,
    scope: {
      kind: "experiment",
      dimension: winner.dimension,
      segment: winner.segment,
      rep_ctr: winner.ctr,
      org_ctr: orgCtr,
      delta_pp: Math.round(winner.delta * 1000) / 10,
      rep_n: winner.n,
      lookback_days: 30,
    },
    description,
  };
}

/** Shared seed logic. POST (admin) and GET (cron) both call this. */
async function seedMissions(): Promise<{ today: string; results: SeedResult[] }> {
  const today = todayIso();

  // Only target sales reps. Admins (role='admin') don't have email
  // sending queues — they review proposals/edits, not send. Without
  // this filter the heuristic seeded send=5 missions for admin
  // accounts that had nothing to send (smoke 2026-05-10 #3).
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, sender_name, name, role, active")
    .eq("active", true)
    .eq("role", "sales");
  if (!reps || reps.length === 0) {
    return { today, results: [] };
  }

  const results: SeedResult[] = [];

  for (const r of reps) {
    const repId = r.id as number;
    const repName = ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${repId}`);

    // Skip if today already has any missions for this rep.
    const { data: existing } = await supabase
      .from("missions")
      .select("id")
      .eq("rep_id", repId)
      .eq("due_date", today)
      .limit(1);
    if (existing && existing.length > 0) {
      results.push({ rep_id: repId, rep_name: repName, send_target: 0, reply_target: 0, skipped_reason: "already has missions today" });
      continue;
    }

    // Send target — sourced from admin-set daily quota.
    const quota = await getEffectiveQuota(repId, today);
    const sendTarget = sumPerPool(quota.per_pool);
    if (sendTarget <= 0) {
      if (!notifiedThisRun.has(repId)) {
        await notifyAdminMissingQuota({ id: repId, name: repName });
        notifiedThisRun.add(repId);
      }
      // Skip send mission, but still allow reply mission to be created if there's inbound.
    }

    // Reply target — count inbound replies that haven't been
    // acknowledged. Cheap proxy: inbound_emails rows where the source
    // email's actor was this rep, in the last 7 days.
    const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: myEmails } = await supabase
      .from("emails")
      .select("id")
      .eq("actor_rep_id", repId)
      .gte("created_at", since7)
      .limit(500);
    const myEmailIds = (myEmails ?? []).map((e) => e.id as string);
    let replyTarget = 0;
    if (myEmailIds.length > 0) {
      const { count: inboundCount } = await supabase
        .from("inbound_emails")
        .select("id", { count: "exact", head: true })
        .in("source_email_id", myEmailIds);
      replyTarget = Math.min(5, inboundCount ?? 0);
    }

    // Insert missions.
    const rows: Array<Record<string, unknown>> = [];
    if (sendTarget > 0) {
      const pp = quota.per_pool;
      const breakdown = [
        pp.strong > 0 ? `${pp.strong} strong` : null,
        pp.normal_cn > 0 ? `${pp.normal_cn} 国内` : null,
        pp.normal_overseas > 0 ? `${pp.normal_overseas} 海外` : null,
        pp.normal_edu > 0 ? `${pp.normal_edu} .edu` : null,
      ].filter(Boolean).join(" + ");
      rows.push({
        rep_id: repId,
        due_date: today,
        kind: "send",
        target: sendTarget,
        scope: {
          per_pool: quota.per_pool,
          direction_priority: quota.direction_priority,
        },
        description: `今天的目标: 发 ${sendTarget} 封 (${breakdown}). 早上 9 点系统会自动分配到你 queue.`,
        generated_by: "heuristic",
        status: "active",
      });
    }
    if (replyTarget > 0) {
      rows.push({
        rep_id: repId,
        due_date: today,
        kind: "reply",
        target: replyTarget,
        description: `回复 ${replyTarget} 个 inbound (你过去 7 天发的邮件收到的回信).`,
        generated_by: "heuristic",
        status: "active",
      });
    }

    // Mondays only: add a qualitative "experiment" mission that gives
    // each rep ONE focus area for the week beyond raw send counts.
    // Surfaces their strongest segment vs org baseline so they can
    // double-down where they're already winning. Skips reps without
    // enough signal (<20 sends in 30d). See buildExperimentMission.
    const isMonday = new Date().getUTCDay() === 1;
    if (isMonday) {
      const exp = await buildExperimentMission(repId, repName);
      if (exp) {
        rows.push({
          rep_id: repId,
          due_date: today,
          kind: "experiment",
          target: exp.target,
          scope: exp.scope,
          description: exp.description,
          generated_by: "heuristic",
          status: "active",
        });
      }
    }

    if (rows.length > 0) {
      const { error } = await supabase.from("missions").insert(rows);
      if (error) {
        results.push({ rep_id: repId, rep_name: repName, send_target: 0, reply_target: 0, skipped_reason: `insert failed: ${error.message}` });
        continue;
      }
    }

    const seedResult: SeedResult = { rep_id: repId, rep_name: repName, send_target: sendTarget, reply_target: replyTarget };
    if (sendTarget === 0) seedResult.skipped_send_reason = "no_quota";
    results.push(seedResult);
  }

  return { today, results };
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const out = await seedMissions();
  return NextResponse.json(out);
}

/**
 * GET /api/missions/heuristic-seed — cron entry point.
 * Auth: Bearer $CRON_SECRET. Vercel cron runs this daily 02:00 UTC
 * (10:00 Beijing) so reps see today's missions when they log in.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const out = await seedMissions();
  return NextResponse.json(out);
}
