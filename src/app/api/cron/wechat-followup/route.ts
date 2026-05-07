import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { sendMessage } from "@/lib/lark";
import { getStaleWechatFollowups } from "@/lib/wechat-followup";

export const maxDuration = 60;

/**
 * GET /api/cron/wechat-followup
 *
 * Daily 10am-Beijing weekday DM to reps with stale wechat marks
 * (added wechat ≥3 days ago, no inbound reply since). Composes a
 * 1-2 line nudge with the oldest 1-2 stale items per rep.
 *
 * Schedule: "0 2 * * 1-5" (UTC 2am = Beijing 10am Mon-Fri).
 *
 * Idempotency: we don't track "did we already nudge today" — Vercel
 * cron fires once per schedule. If the same rep gets the same nudge
 * tomorrow, that's intentional (the wechat lead is still warm and
 * the rep still hasn't acted).
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const isVercelCron = req.headers.get("authorization") === `Bearer ${secret}`;
  if (!isVercelCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Active sales reps with bound Lark accounts.
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id, role")
    .eq("active", true)
    .eq("role", "sales")
    .not("lark_open_id", "is", null);

  const results: Array<{ rep_id: number; name: string; sent: boolean; staleCount: number; reason?: string }> = [];

  for (const rep of reps ?? []) {
    try {
      const stale = await getStaleWechatFollowups(rep.id);
      if (stale.length === 0) {
        results.push({ rep_id: rep.id, name: rep.name, sent: false, staleCount: 0, reason: "no stale" });
        continue;
      }
      // Pick the 2 oldest. More than that is overwhelming for a chat
      // nudge — if you have 10 stale wechat marks the right answer is
      // a dashboard view, not a wall-of-text DM.
      const top = stale.slice(0, 2);
      const lines: string[] = [
        `${rep.name}, 这边有 ${stale.length} 条微信加过但还没回的:`,
      ];
      for (const s of top) {
        const who = s.recipient ?? "(unknown)";
        const title = s.lead_title ? `《${s.lead_title.slice(0, 50)}》` : "";
        lines.push(`  • ${who} ${title} — 加了 ${s.days_stale} 天还没回`);
      }
      if (stale.length > top.length) {
        lines.push(`  (还有 ${stale.length - top.length} 条, 完整在 /emails 看)`);
      }
      lines.push(`要不要 chime back 一下? "在不在? 上次提到的算力支持..."`);

      const r = await sendMessage({
        receive_id: rep.lark_open_id!,
        receive_id_type: "open_id",
        text: lines.join("\n"),
      });
      results.push({
        rep_id: rep.id,
        name: rep.name,
        sent: r.ok,
        staleCount: stale.length,
        reason: r.error,
      });
    } catch (e) {
      results.push({
        rep_id: rep.id,
        name: rep.name,
        sent: false,
        staleCount: 0,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    repsConsidered: (reps ?? []).length,
    sent: results.filter((r) => r.sent).length,
    skipped: results.filter((r) => !r.sent).length,
    details: results,
  });
}
