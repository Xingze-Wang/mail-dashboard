import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { sendMessage } from "@/lib/lark";
import { countLeads, countReplies, countWechatConversions, getMpConversionMatrix } from "@/lib/canonical-counts";

export const maxDuration = 60;

/**
 * GET /api/cron/standup
 *
 * Daily 9am-Beijing weekday DM to each active sales rep with their
 * day-opening picture: how many leads are ready, did anyone reply
 * overnight, any wechat follow-ups due.
 *
 * Schedule (vercel.json): "0 1 * * 1-5" — 1am UTC = 9am Beijing,
 * Mon-Fri.
 *
 * Skips reps without lark_open_id, skips admins (they have their own
 * dashboard), and silently skips reps with zero "things to mention"
 * (no nag if there's nothing real to say — better than spamming).
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

  // Pull active reps with bound Lark accounts. Sales reps get the
  // per-rep "your queue / your replies" DM; admins get the org-wide
  // daily report (buildAdminDailyReport).
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id, role")
    .eq("active", true)
    .in("role", ["sales", "admin"])
    .not("lark_open_id", "is", null);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sinceWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const results: Array<{ rep_id: number; name: string; sent: boolean; reason?: string }> = [];

  for (const rep of reps ?? []) {
    try {
      // ─── Admin path: org-wide daily report ─────────────────────────
      if (rep.role === "admin") {
        const { buildAdminDailyReport } = await import("@/lib/admin-daily-report");
        const text = await buildAdminDailyReport();
        const r = await sendMessage({
          receive_id: rep.lark_open_id!,
          receive_id_type: "open_id",
          text,
        });
        if (r.ok) {
          await supabase
            .from("lark_messages")
            .insert({
              chat_id: `dm:${rep.lark_open_id}`,
              rep_id: rep.id,
              role: "system",
              text: text.slice(0, 4000),
            })
            .then(() => null, () => null);
        }
        results.push({ rep_id: rep.id, name: rep.name, sent: r.ok, reason: r.error });
        continue;
      }

      // ─── Sales-rep path — all counts via canonical-counts ─────────
      // 1. Ready leads in their queue
      // 2. Inbound replies in last 24h (rep_id stamped at write time)
      // 3. Wechat marks this week (for "you've been busy" framing)
      // 4. MP CRM conversions this week (注册 / 开表 — ground-truth funnel)
      const [readyResult, replyResult, wechatResult, mpMatrix] = await Promise.all([
        countLeads({ repId: rep.id, status: "ready" }),
        countReplies({ repId: rep.id, since: since24h }),
        countWechatConversions({ markedByRepId: rep.id, since: sinceWeek }),
        getMpConversionMatrix({ actorRepId: rep.id, since: sinceWeek }).catch((e) => {
          console.error(`[standup] mp matrix failed for rep ${rep.id}:`, e);
          return null;
        }),
      ]);
      const readyCount = readyResult.count;
      const replyCount = replyResult.count;
      const weeklyWechat = wechatResult.count;
      const weeklyRegistered = mpMatrix?.registered ?? 0;
      const weeklySubmitted = mpMatrix?.submittedApplication ?? 0;

      // Skip silently if everything is zero — no nag-spam.
      if ((readyCount ?? 0) === 0 && (replyCount ?? 0) === 0) {
        results.push({ rep_id: rep.id, name: rep.name, sent: false, reason: "nothing to say" });
        continue;
      }

      // Compose a 2-3 line message. Tone: light, not robotic.
      const lines: string[] = [`早, ${rep.name} ☀️`];
      if ((readyCount ?? 0) > 0) {
        lines.push(`今天你有 **${readyCount}** 条 lead 在 /pipeline 等你过. ${
          (readyCount ?? 0) >= 5 ? "看看哪些值得发, 不急." : ""
        }`);
      }
      if ((replyCount ?? 0) > 0) {
        lines.push(`过去 24 小时收到 **${replyCount}** 条新回复. /emails 看一眼?`);
      }
      if ((weeklyWechat ?? 0) >= 3) {
        lines.push(`(过去一周加了 ${weeklyWechat} 个微信, 不错的节奏 👍)`);
      }
      // MP CRM conversion line — only show when any signal > 0.
      // Format: "本周转化: 注册 X · 开表 Y · 微信 Z"
      if (weeklyRegistered > 0 || weeklySubmitted > 0 || (weeklyWechat ?? 0) > 0) {
        lines.push(`本周转化: 注册 ${weeklyRegistered} · 开表 ${weeklySubmitted} · 微信 ${weeklyWechat ?? 0}`);
      }
      lines.push(`有问题随时 DM 我.`);

      const r = await sendMessage({
        receive_id: rep.lark_open_id!,
        receive_id_type: "open_id",
        text: lines.join("\n"),
      });
      results.push({ rep_id: rep.id, name: rep.name, sent: r.ok, reason: r.error });
    } catch (e) {
      // One rep's failure doesn't kill the loop — we want every other
      // rep to still get their standup.
      results.push({
        rep_id: rep.id,
        name: rep.name,
        sent: false,
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
