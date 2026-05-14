import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { sendMessage } from "@/lib/lark";

export const maxDuration = 60;

/**
 * GET /api/cron/weekly-checkin
 *
 * Monday-only DM to each sales rep: "here's how last week actually
 * went, what's the plan this week, anything blocking?" The reply lands
 * back in helper_messages via the normal Lark webhook → Leon can recall
 * it next week (and the admin can read everyone's weekly state).
 *
 * Schedule (vercel.json): "0 1 * * 1" — Monday 09:00 Beijing.
 *
 * Why Monday over Sunday-night: gives the rep their weekend uncluttered
 * but still arrives before the day-of-week mood sets in. The standup
 * cron also runs Mon-Fri 09:00, but we send weekly-checkin five minutes
 * earlier so it lands first in the unread queue.
 *
 * Tone: peer-to-peer (老师傅 framing), not boss surveillance. The
 * rep should feel like a teammate is asking, not being audited.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const isVercelCron = req.headers.get("authorization") === `Bearer ${secret}`;
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!isVercelCron && !force) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Last full week: Mon 00:00 → Sun 23:59:59, ending yesterday.
  const now = new Date();
  const lastSunday = new Date(now);
  lastSunday.setUTCHours(23, 59, 59, 999);
  lastSunday.setUTCDate(now.getUTCDate() - now.getUTCDay()); // back to last Sunday
  const lastMonday = new Date(lastSunday);
  lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);
  lastMonday.setUTCHours(0, 0, 0, 0);

  const since = lastMonday.toISOString();
  const until = lastSunday.toISOString();

  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id, role")
    .eq("active", true)
    .eq("role", "sales")          // admins get their own org-wide weekly
    .not("lark_open_id", "is", null);

  const results: Array<{ rep_id: number; name: string; sent: boolean; reason?: string }> = [];

  for (const rep of reps ?? []) {
    try {
      // Last-week numbers, all attributed to ACTOR not OWNER (per
      // CLAUDE.md attribution rules — closer gets credit).
      const [sends, replies, wechats] = await Promise.all([
        supabase
          .from("emails")
          .select("id", { count: "exact", head: true })
          .eq("actor_rep_id", rep.id)
          .gte("sent_at", since)
          .lte("sent_at", until),
        supabase
          .from("inbound_emails")
          .select("id", { count: "exact", head: true })
          .eq("rep_id", rep.id)
          .gte("created_at", since)
          .lte("created_at", until),
        supabase
          .from("brief_lookups")
          .select("id", { count: "exact", head: true })
          .eq("marked_by_rep_id", rep.id)
          .eq("added_wechat", true)
          .gte("wechat_at", since)
          .lte("wechat_at", until),
      ]);

      const sendCount = sends.count ?? 0;
      const replyCount = replies.count ?? 0;
      const wechatCount = wechats.count ?? 0;
      const replyRate = sendCount > 0 ? Math.round((replyCount / sendCount) * 100) : 0;

      // Compose. Numbers framed as "here's what I saw" not "here's
      // your score". Open-ended ask at the end.
      const lines: string[] = [
        `Morning, ${rep.name} ☀️ — quick Monday check-in.`,
        ``,
        `**Last week** (${since.slice(0, 10)} → ${until.slice(0, 10)}):`,
        `· ${sendCount} sends, ${replyCount} replies${sendCount > 0 ? ` (${replyRate}% reply rate)` : ""}`,
        `· ${wechatCount} WeChat conversions`,
      ];

      // Light contextual line — only if signal is strong enough to matter.
      if (sendCount === 0) {
        lines.push(`(zero sends last week — anything blocking, or just a quiet week?)`);
      } else if (replyRate >= 30) {
        lines.push(`(${replyRate}% reply rate is strong — whatever you did, keep it.)`);
      } else if (sendCount >= 20 && replyRate < 5) {
        lines.push(`(volume was there but replies thin — want to look at a few sent emails together?)`);
      }

      lines.push(
        ``,
        `**Three things I'd love your read on this week:**`,
        `1. How did last week actually feel — momentum, grind, or somewhere in between?`,
        `2. What's the plan for this week? Any specific bets you want to make?`,
        `3. Anything in the way — leads, templates, the helper, the dashboard, anything?`,
        ``,
        `Reply here when you have a sec. Whatever you say lands in our shared memory so we can come back to it next week.`,
      );

      const r = await sendMessage({
        receive_id: rep.lark_open_id!,
        receive_id_type: "open_id",
        text: lines.join("\n"),
      });

      // Mirror into helper_messages so Leon's recall sees this prompt
      // alongside the rep's reply (same pattern as standup mirroring).
      if (r.ok) {
        await supabase
          .from("lark_messages")
          .insert({
            chat_id: `dm:${rep.lark_open_id}`,
            rep_id: rep.id,
            role: "system",
            text: lines.join("\n").slice(0, 4000),
            metadata: { kind: "weekly_checkin", week_starting: since.slice(0, 10) },
          })
          .then(() => null, () => null);
      }

      results.push({ rep_id: rep.id, name: rep.name, sent: r.ok, reason: r.error });
    } catch (e) {
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
    weekStart: since,
    weekEnd: until,
    repsConsidered: (reps ?? []).length,
    sent: results.filter((r) => r.sent).length,
    details: results,
  });
}
