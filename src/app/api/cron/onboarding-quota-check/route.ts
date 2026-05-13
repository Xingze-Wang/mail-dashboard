import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const preferredRegion = ["hkg1"];
export const maxDuration = 60;

/**
 * GET /api/cron/onboarding-quota-check
 *
 * Daily cron at 08:00 Beijing. For each newly-onboarded sales rep
 * (created in the last 7 days) whose daily quota is still zero after
 * 24h, DM the admin to remind them to set it (and to discuss the
 * desired daily volume with the rep).
 *
 * Without this, a new rep gets zero leads tomorrow because the
 * allocation cron skips reps whose sum(per_pool) === 0.
 *
 * Dedup: per-day sentinel row in rep_daily_quotas_override with
 * reason='_quota_check_dm_marker' (excluded from real quota lookup
 * because reason starts with '_' — see quota-store.ts).
 *
 * Auth: Bearer $CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ADMIN_OPEN_ID = process.env.ADMIN_LARK_OPEN_ID;
  if (!ADMIN_OPEN_ID) {
    return NextResponse.json({ checked: 0, dmd: 0, reason: "no_admin_open_id" });
  }

  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const reps = await supabase
    .from("sales_reps")
    .select("id, name, created_at, role, sender_email, active")
    .gte("created_at", since)
    .eq("active", true)
    .eq("role", "sales");
  if (reps.error) {
    return NextResponse.json({ error: reps.error.message }, { status: 500 });
  }

  const { sendMessage } = await import("@/lib/lark");
  let dmd = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const rep of reps.data || []) {
    const ageHours = (Date.now() - new Date(rep.created_at as string).getTime()) / 3_600_000;
    if (ageHours < 24) continue;

    const q = await supabase
      .from("rep_daily_quotas")
      .select("per_pool")
      .eq("rep_id", rep.id)
      .maybeSingle();

    const pp = (q.data?.per_pool ?? {}) as Record<string, number>;
    const total =
      (pp.strong ?? 0) +
      (pp.normal_cn ?? 0) +
      (pp.normal_overseas ?? 0) +
      (pp.normal_edu ?? 0);
    if (total > 0) continue;

    // Dedup: don't DM admin twice in one day for the same rep.
    const probe = await supabase
      .from("rep_daily_quotas_override")
      .select("id")
      .eq("rep_id", rep.id)
      .eq("due_date", today)
      .eq("reason", "_quota_check_dm_marker")
      .maybeSingle();
    if (probe.data) continue;

    await sendMessage({
      receive_id: ADMIN_OPEN_ID,
      receive_id_type: "open_id",
      text:
        `⏰ ${rep.name} 已经接入 ${Math.floor(ageHours / 24)} 天了, 但 daily quota 还是 0. ` +
        `他/她今天还是收不到 lead. 去 /admin/missions 设一下, 或者跟他/她聊聊节奏.`,
    }).catch(() => null);

    await supabase.from("rep_daily_quotas_override").insert({
      rep_id: rep.id,
      due_date: today,
      per_pool: { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 },
      reason: "_quota_check_dm_marker",
    });
    dmd++;
  }

  return NextResponse.json({ checked: reps.data?.length || 0, dmd });
}
