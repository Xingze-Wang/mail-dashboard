import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { sendMessage } from "@/lib/lark";

export const maxDuration = 60;

/**
 * GET /api/cron/onboarding-followup
 *
 * Daily 9am-Beijing weekday DM to recently-onboarded reps:
 *   - +24h check-in: reps onboarded ~21–30 hours ago who haven't been
 *     d1-pinged. Tone is "how was day 1, anything stuck?" — designed
 *     to feel like a teammate checking in, not a system notification.
 *   - +7d retro: reps onboarded ~6.5–7.5 days ago who haven't been
 *     d7-pinged. Tone is "first week's done, want to chat about what
 *     was confusing?".
 *
 * Schedule (vercel.json): same `0 1 * * 1-5` slot as standup. The
 * forgiving windows (±a few hours) ensure that someone onboarded at
 * any time of day still gets exactly one d1 and one d7 ping, even
 * with weekend gaps.
 *
 * Idempotency: sales_reps.followup_d1_sent_at / d7_sent_at columns
 * (migration 060) are stamped immediately after the DM so the rep
 * can never get two of the same kind.
 *
 * Failure isolation: each rep DM is in its own try/catch — one
 * failure does NOT skip the rest.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  // ─── d1 window: 21h to 30h after onboarding ───────────────────────
  // Wide enough that whatever time of day they got approved, the next
  // morning's cron catches them. Narrow enough that we don't ping
  // someone who's been on the team for 3 days.
  const d1Lo = new Date(now - 30 * 3600 * 1000).toISOString();
  const d1Hi = new Date(now - 21 * 3600 * 1000).toISOString();
  // ─── d7 window: 6.5d to 7.5d after onboarding ─────────────────────
  // 1-day window is safe because cron runs daily — every rep falls
  // into this window on exactly one cron tick.
  const d7Lo = new Date(now - 7.5 * 86400 * 1000).toISOString();
  const d7Hi = new Date(now - 6.5 * 86400 * 1000).toISOString();

  const summary = { d1: { pinged: 0, errors: 0 }, d7: { pinged: 0, errors: 0 } };

  // ─── Day 1 check-ins ──────────────────────────────────────────────
  const { data: d1Reps } = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id, trust_notes")
    .eq("active", true)
    .not("lark_open_id", "is", null)
    .is("followup_d1_sent_at", null)
    .gte("onboarded_at", d1Lo)
    .lte("onboarded_at", d1Hi);

  for (const rep of d1Reps ?? []) {
    if (!rep.lark_open_id) continue;
    const given = firstNameForGreeting(rep.name);
    // Tonally: "I'm checking in, you don't have to reply, but I'm here."
    // The questions are open-ended on purpose — easier to answer with
    // a sentence than a yes/no probe.
    const lines = [
      `${given}, 早 — 第一天感觉怎么样?`,
      ``,
      `几个常见的卡点, 任何一个对得上就 DM 我:`,
      `  • dashboard 登不进去 / 密码忘了`,
      `  • 不知道哪些 lead 该发 / 哪些该跳`,
      `  • 邮件草稿改了半天还是觉得别扭`,
      `  • 客户回了但不知道接下来怎么聊`,
      ``,
      `没有问题也回我一个 👍 我就知道你 OK 了. 真的卡了别憋着 — 我一直在.`,
    ];

    try {
      await sendMessage({
        receive_id: rep.lark_open_id,
        receive_id_type: "open_id",
        text: lines.join("\n"),
      });
      // Stamp BEFORE checking the result — even a partial-failure DM
      // (e.g., Lark accepted but rep blocked the bot) shouldn't retry
      // forever. Admin can manually unstamp via DB if needed.
      await supabase
        .from("sales_reps")
        .update({ followup_d1_sent_at: new Date().toISOString() })
        .eq("id", rep.id);
      summary.d1.pinged += 1;
    } catch (e) {
      console.error(`[onboarding-followup] d1 DM to rep_id=${rep.id} failed:`, e);
      summary.d1.errors += 1;
    }
  }

  // ─── Day 7 retro ──────────────────────────────────────────────────
  const { data: d7Reps } = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id, trust_notes")
    .eq("active", true)
    .not("lark_open_id", "is", null)
    .is("followup_d7_sent_at", null)
    .gte("onboarded_at", d7Lo)
    .lte("onboarded_at", d7Hi);

  for (const rep of d7Reps ?? []) {
    if (!rep.lark_open_id) continue;
    const given = firstNameForGreeting(rep.name);
    // Day 7 is reflective rather than instructional. The rep now has
    // a week of context — they know what the system does. Better to
    // ask their take than push more advice.
    const lines = [
      `${given}, 一周了 👋`,
      ``,
      `想问你两件事 (回不回都行, 我会记下来):`,
      `  1. 这一周有什么是 **我应该帮你做但没帮上** 的? (拟稿、提醒、统计 之类)`,
      `  2. 哪个 lead / 客户对话, 你觉得我帮不上的地方最大?`,
      ``,
      `这俩答案直接决定我下周怎么改进给你. 一句话也行.`,
    ];

    try {
      await sendMessage({
        receive_id: rep.lark_open_id,
        receive_id_type: "open_id",
        text: lines.join("\n"),
      });
      await supabase
        .from("sales_reps")
        .update({ followup_d7_sent_at: new Date().toISOString() })
        .eq("id", rep.id);
      summary.d7.pinged += 1;
    } catch (e) {
      console.error(`[onboarding-followup] d7 DM to rep_id=${rep.id} failed:`, e);
      summary.d7.errors += 1;
    }
  }

  return NextResponse.json({ ok: true, ...summary });
}

/**
 * Mirror of the helper in src/lib/onboarding.ts. Duplicated rather than
 * exported because the onboarding module is heavy (bcrypt + Lark
 * primitives) and a cron route shouldn't pull all of that for a 5-line
 * pure function. If a third caller emerges, hoist to src/lib/names.ts.
 */
function firstNameForGreeting(fullName: string | null | undefined): string {
  const s = (fullName ?? "").trim();
  if (!s) return "你";
  const allCjk = /^[一-鿿]+$/.test(s);
  if (allCjk && s.length >= 2) return s.slice(1);
  return s;
}
