import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";
import { DAILY_OVERRIDE_CAP, countOverridesTodayByRep, beijingDayStartUtc } from "@/lib/override-quota";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/help/opening
 *
 * Returns the daily opener for the helper. Fires once per Beijing day
 * per rep — if the rep's `helper_rep_state.last_greeting_at` is inside
 * today's Beijing window, returns `{ skip: true }` and the client
 * doesn't seed.
 *
 * Voice: crisp, facts-first. No emoji, no filler.
 *
 * Contextual data piped into the prompt:
 * - yesterday's sent count (email log, filtered to this rep)
 * - today so far: ready count, sent count, override used / cap
 * - unread replies (inbound_emails scoped to rep's threads)
 *
 * Shape:
 *   { skip: false, greeting: "早. 昨天发了 12, 回了 2. 今天 ready 17, override 0/200. 要开 review 吗?" }
 *   { skip: true }  — already greeted today
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repId = session.repId;
  const todayStart = beijingDayStartUtc();
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const todayStartIso = todayStart.toISOString();
  const yesterdayStartIso = yesterdayStart.toISOString();

  // State row — upsert lazily.
  const { data: state } = await supabase
    .from("helper_rep_state")
    .select("last_greeting_at")
    .eq("rep_id", repId)
    .maybeSingle();

  const lastGreeting = state?.last_greeting_at ? new Date(state.last_greeting_at) : null;
  if (lastGreeting && lastGreeting >= todayStart) {
    return NextResponse.json({ skip: true });
  }

  // Gather today/yesterday stats.
  const { data: rep } = await supabase.from("sales_reps").select("sender_email").eq("id", repId).maybeSingle();

  const [readyQ, sentTodayQ, sentYesterdayQ] = await Promise.all([
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "ready"),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "sent").gte("sent_at", todayStartIso),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "sent").gte("sent_at", yesterdayStartIso).lt("sent_at", todayStartIso),
  ]);
  const readyCount = readyQ.count ?? 0;
  const sentToday = sentTodayQ.count ?? 0;
  const sentYesterday = sentYesterdayQ.count ?? 0;

  let unreadReplies = 0;
  if (rep?.sender_email) {
    const { data: outs } = await supabase
      .from("emails")
      .select("thread_id")
      .ilike("from", `%${rep.sender_email}%`)
      .not("thread_id", "is", null);
    const threadIds = (outs ?? []).map((r) => r.thread_id as string).filter(Boolean);
    if (threadIds.length > 0) {
      const { count } = await supabase
        .from("inbound_emails")
        .select("*", { count: "exact", head: true })
        .eq("is_read", false)
        .in("thread_id", threadIds);
      unreadReplies = count ?? 0;
    }
  }

  const overrideUsed = (await countOverridesTodayByRep(repId)) ?? 0;

  // Decide rough time-of-day label (Beijing). Used only to nudge tone.
  const nowBeijing = new Date(Date.now() + 8 * 3600 * 1000);
  const hour = nowBeijing.getUTCHours();
  const timeHint = hour < 11 ? "早上" : hour < 14 ? "中午" : hour < 18 ? "下午" : "晚上";

  const facts = {
    rep_name: session.repName,
    time_of_day: timeHint,
    yesterday_sent: sentYesterday,
    today_ready: readyCount ?? 0,
    today_sent: sentToday ?? 0,
    today_override_used: overrideUsed,
    today_override_cap: DAILY_OVERRIDE_CAP,
    unread_replies: unreadReplies,
  };

  // LLM produces a crisp opener. NOT JSON, just the Chinese sentence.
  const SYSTEM = `你是 rep 的搭档. 一句话或两句话的 daily opener.

规则 (硬规则):
- 短. 两句以内.
- 事实先行. 没用的形容词不要.
- 不用 emoji.
- 不用 "哈" "呀" "呢" "哦" "嘿" 等语气词.
- 不用 "您" "请问".
- 最后一句如果适合, 提一个明确的问题 ("要开 review 吗" / "要看看 replies 吗" / "要先处理 X 吗"). 不是每次都要问, 取决于是否有明显下一步.
- 不要自我介绍 ("我是助手"), rep 知道你是谁.
- 中英混排 OK, 但不要中文里夹过多英文短语.

只输出给 rep 看的文字, 不要 markdown, 不要前缀.`;

  const user = `## 今天的情况
rep_name: ${facts.rep_name}
time_of_day: ${facts.time_of_day}
yesterday_sent: ${facts.yesterday_sent}
today_ready: ${facts.today_ready}
today_sent: ${facts.today_sent}
today_override_used: ${facts.today_override_used} / ${facts.today_override_cap}
unread_replies: ${facts.unread_replies}

写一句日常 opener. 如果昨天有 sent 数字, 可以提; 如果今天有 ready, 可以推动; 如果有 unread_replies, 这个优先 (更值得看). 如果什么都没动, 就简单打个招呼问要不要开始.`;

  let greeting = "";
  try {
    const r = await llmChat({ model: "gemini-3-flash", system: SYSTEM, user, temperature: 0.4, max_tokens: 200, timeoutMs: 15_000 });
    greeting = r.text.trim();
  } catch {
    // Fallback — rule-based so we never fail the opener.
    if (unreadReplies > 0) greeting = `${unreadReplies} 条新回复没看. 先看一下?`;
    else if ((readyCount ?? 0) > 0) greeting = `今天 ready ${readyCount} 条. 要开 review 吗?`;
    else greeting = `今天 queue 空的. 等下一波 scan.`;
  }

  // Mark as greeted (upsert).
  await supabase
    .from("helper_rep_state")
    .upsert({
      rep_id: repId,
      last_greeting_at: new Date().toISOString(),
      last_opened_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "rep_id" });

  return NextResponse.json({ skip: false, greeting });
}
