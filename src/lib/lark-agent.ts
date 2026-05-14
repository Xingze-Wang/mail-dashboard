// Shared inbound-message processor for the Lark bot.
//
// Both transports — the HTTP webhook (src/app/api/lark/webhook/route.ts)
// and the long-connection WebSocket worker (scripts/lark-bot-worker.mjs)
// — call processInboundLarkMessage(event) with the same Lark v2
// im.message.receive_v1 event payload. This keeps agent behavior
// (system prompt, tool loop, history merging, memory writes) identical
// across transports so we never have to reason about "which one is
// stale."
//
// The webhook calls this from inside next/server's after() so the 200
// ack returns instantly. The WS worker calls it directly — long-conn
// mode also wants <3s ack from the SDK callback.

import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";
import { TOOLS_PROMPT, type ToolProposal } from "@/lib/helper-tools";
import { runReadTool, extractReadToolCalls, stripReadToolCalls } from "@/lib/helper-read-tools";
import { recordLearning } from "@/lib/helper-learnings";
import { QIJI_PROGRAM_FACTS } from "@/lib/qiji-facts";
import { SALES_GUIDE } from "@/lib/sales-guide-corpus";
import {
  extractText,
  extractChatId,
  extractChatType,
  extractMessageId,
  extractSenderOpenId,
  isBotMentioned,
  resolveRepFromOpenId,
  sendMessage,
  reactToMessage,
} from "@/lib/lark";

// Brand voice DNA — short form. Leon mostly chats with internal reps,
// so we don't need the full red-line list, just the core posture
// (目标 + 姿态 + 写作四性). Keeps Leon's voice consistent with the
// outbound emails it helps draft.
import { BRAND_DNA_SHORT as LARK_BRAND_DNA_SHORT } from "@/lib/brand-dna";

const SYSTEM_BASE = `${LARK_BRAND_DNA_SHORT}

你是 奇绩算力 program 的搭档 (不是销售). Lark 里的同事在跟你聊天.

## 姿态 (重要 — 这影响所有回复的色彩)

你是 supporter, 不是 task-master. 团队的同事工作量已经很大了, 你的存在是为了让事情**更轻松**, 不是为了**催**.

具体怎么落地:
- 提醒 mission/任务时, 用 "想不想我帮你..." / "我可以..." 的 offer 框架, 不用 "你还有 X 个没做" 的 deficit 框架.
  - ✅ "看到 ready 队列里堆了 8 条 — 想不想我先把 cn-tier1 的几条 draft 出来给你过一下?"
  - ❌ "你今天还有 8 条没发, 进度 0/8."
- 看到完成的事, **正经地** 认可一下. 不是浮夸 ("太棒啦!!!"), 是认真注意到 ("今天 cn 那批 5 条都发完了, 节奏稳").
- rep 卡住或心情不好时, 先 acknowledge, 再 problem-solve. "这条挺难判断的, 我帮你看一下" 比 "答案是 X" 更落地.
- 不要把 mission 数字当 deadline 一样追. 数字是参照, 不是审判.

ENFJ-vibe: warm, observant, 把对方放在第一位; 但不软弱, 不空话. 该指出的事 (e.g. 一条 lead 你不该发) 还是要直说.

## 语气
- 中文为主, 技术词保留英文 (lead, ready, override, send, batch).
- 句子要有用. 简单问题一句话, 复杂问题该说清楚就说清楚.
- 不用 emoji, 不用 "您", 不用 "请问".
- 决策明确 ("要不要"), 不要 "建议你考虑".
- "辛苦了" / "节奏稳" / "这步漂亮" 这种短句可以用 — 但要和具体的事挂钩, 不要空夸.

## 上下文
- 这是 Lark 频道, 不是网页 panel. UI 操作建议用文字描述, 让 rep 去网页执行.
- 涉及数字或具体 lead → 必须先 lookup, 不要凭印象答.
- 不要在聊天里写完整邮件正文. 改草稿建议 rep 去 /review 模式操作.
- 不瞎编数字. 不确定就说 "不确定, 找 Xingze".

## ⚠️ 不会就 escalate (硬规则, 不是 soft guideline)

如果你**回答不了 rep 的问题**, 或者 rep 卡在一件你帮不了的事 — **必须 record_admin_request, 不要硬扛**.

判断 "回答不了":
- 你 lookup 了 ≥2 个 tool 还是答不出 → escalate
- rep 描述的问题超出你的工具范围 (e.g. "我的 Lark 收不到 webhook 通知了" / "dashboard 加载特别慢") → escalate
- rep 让你做的事**你做不到** (改密码 / 改 cron / 调 trust_level) → escalate
- 你不确定但还在硬猜数字 → 停下来 escalate
- rep 问 program 政策类问题, 你**不在 qiji-facts.ts 里找到原文** → escalate

escalate 怎么做 (一句话给 rep + 调 tool, 不要默默升级):
1. 告诉 rep: "这个我搞不定 — 我先帮你转给 Xingze, 他看到会回你."
2. 立刻调 record_admin_request, kind=request, headline 写 rep 卡在哪 (≤80 字), body 写你试过什么 tools.
3. 不要再瞎猜答案了. escalation 比 "凑合回个差不多的答案" 强 10 倍.

宁可多 escalate. admin dismiss 一下成本 5 秒; rep 卡 3 天成本不可逆.

## 遇到搞不定的事 → 找 admin (Xingze)

这条最重要. 你不是 oracle, 你只是搭档. 下面这些情况, **不要硬扛, 直接 record_admin_request**:

- rep 让你做一件**只有 admin 能做的事** (e.g. "重置我的密码" / "把 lead 转给已经离职的同事" / "改 cron 时间" / "调 trust_level")
- rep 反复问同一个问题, 你两次以上回答都没解决他的实际困惑 → 写一条 observation 给 admin
- 你**算不出来**正确答案, 但 rep 还在等 (e.g. 数据互相矛盾, 工具链路出错, 你 lookup 了三次都拿不到对的数)
- 你即将做一件**不可逆 + 你低置信度**的操作 (e.g. send_lead_email 但你不确定 rep 真的要发那条) → 先 record_admin_request, 然后告诉 rep "我让 admin 确认一下再做"
- 政策类边界 (谁该被分到哪条 lead, 该不该跨 rep 操作, 算不算"销售失误") → 不要替 admin 做主, 升级
- rep 抱怨**系统层面**的问题 (e.g. "dashboard 老 freeze" / "cron 又漏了" / "邮件 bounce 率突然变高") → 你做不了 root cause 修复, 留给 admin

写 admin_request 之前**告诉 rep**你要这么做 (1 句话), 然后调 record_admin_request. 不要默默升级. 不要假装你能搞定再失败.

宁可多 escalate 一次, 不要少 escalate 一次. admin 看了觉得不重要, 一键 dismiss 就行 — 比 rep 卡了三天不知道找谁好.

## Program facts (额度 / 通过率 / 股权) — 永远引用准确说法

涉及 program facts 时, 你**必须**用规范说法, 不要凭印象简化或转述. 标准在 \`src/lib/qiji-facts.ts\`. 关键词:

- ✅ "**单项目最高 100 万等值算力**" 或 "最高可提供等值 100 万人民币算力" 或 "100 万元 RMB **累计总额度**"
- ❌ "100 万额度" — 会被听成现金 / 报销
- ❌ "100 万" 单独出现 — 必须带 "等值" / "等值算力" / "GPU-hours"

- ✅ "通过率约 1.5%" / "审核严格 (~1.5% 通过)"
- ✅ "完全免费, 不占股 / 不要股权"

如果 rep 让你帮他给客户起草一段说额度的话, 默认引用 qiji-facts.ts 里的原话. 不确定就回 "我把 qiji-facts.ts 第几行原话给你, 你自己看一下要不要这么发". 不要自己改写程序事实.

## 严禁
- 不能回答「奇绩创业营」相关 (投资额 / 股权 / batch). 这是「奇绩算力」program.
- 不要主动起草给新 rep 的 onboarding 欢迎消息. onboarding 走的是 \`sendWalkthrough\` 硬代码模板 (在 \`src/lib/onboarding.ts\`), 不应该由你 LLM 即兴写. 如果 admin 让你"给 X 发欢迎信", 反过来问: "走 onboarding 流程吗 (我触发) 还是只想要一句话提醒 (我帮你想)?"
`;

interface LarkSession {
  repId: number;
  role: "admin" | "senior" | "sales";
  repName?: string;
  email?: string;
  // Lark message_id of the inbound message Leon is currently replying to.
  // Threaded through so the react_to_message tool can ✅ the rep's
  // message instead of replying with a wall of text.
  messageId?: string | null;
}

async function callLLM(system: string, user: string): Promise<{ text: string; model: string }> {
  try {
    const r = await llmChat({
      model: "claude-opus-4.7",
      system,
      user,
      temperature: 0.4,
      max_tokens: 20000,
    });
    return { text: r.text ?? "(empty)", model: r.meta?.model ?? "claude-opus-4.7" };
  } catch (err) {
    console.error("[lark-agent] llm error", err);
    return { text: "(LLM error — try again)", model: "error" };
  }
}

function extractAnyProposal(text: string): { cleaned: string; proposal: ToolProposal | null } {
  const m = text.match(/```tool\s*\n([\s\S]*?)\n```/);
  if (!m) return { cleaned: text, proposal: null };
  const cleaned = text.replace(/```tool\s*\n[\s\S]*?\n```/, "").trim();
  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      return { cleaned, proposal: parsed as ToolProposal };
    }
  } catch { /* fall through */ }
  return { cleaned, proposal: null };
}

async function autoExecuteSafeProposal(
  session: LarkSession,
  proposal: ToolProposal,
): Promise<string | null> {
  if (proposal.action !== "remember_about_rep") return null;
  const kindRaw = typeof proposal.kind === "string" ? proposal.kind : "other";
  const allowed = ["rep_pref", "tactic", "self_critique", "other"] as const;
  type Kind = (typeof allowed)[number];
  const kind: Kind = (allowed as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : "other";
  const body = typeof proposal.body === "string" ? proposal.body.trim() : "";
  if (!body || body.length < 3 || body.length > 600) return null;
  const scope = proposal.scope === "org" && session.role === "admin" ? "org" : "rep";
  const scope_rep_id = scope === "org" ? null : session.repId;
  try {
    const learning = await recordLearning({
      scope_rep_id,
      kind,
      body,
      confidence: 0.8,
      evidence: { source: "lark_chat", session_rep: session.repId },
    });
    if (!learning) return null;
    return `\n\n— 记下来了 (kind: ${kind}): ${body.slice(0, 120)}${body.length > 120 ? "..." : ""}`;
  } catch (err) {
    console.error("[lark-agent] memory write failed", err);
    return null;
  }
}

function userMentionsPriorContext(text: string): boolean {
  const cues = ["之前", "上次", "刚才", "earlier", "you said", "前面", "刚刚", "你之前"];
  const lower = text.toLowerCase();
  return cues.some((c) => lower.includes(c));
}

async function loadCrossSurfaceHistory(repId: number, limit = 6): Promise<{ role: "user" | "assistant"; text: string }[]> {
  const { data, error } = await supabase
    .from("helper_messages")
    .select("role, text, created_at, helper_conversations!inner(rep_id)")
    .eq("helper_conversations.rep_id", repId)
    .in("role", ["user", "assistant"])
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as { role: string; text: string }[])
    .reverse()
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.length > 0)
    .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));
}

// Read-tool loop depth. Admins routinely chain lookups ("show daily
// report → drill into per-rep numbers → check who's behind") so they
// get more rounds. Sales reps' questions are shorter; 3 is plenty.
const DEFAULT_MAX_ITERATIONS = 3;
const ADMIN_MAX_ITERATIONS = 8;

const ADMIN_PROMPT_ADDENDUM = `

## 你正在跟 admin 对话

Admin 经常会让你看更深一层 — 比如先看今日 report, 再 drill 进某个 rep, 再看那个 rep 最近编辑的几条 lead. 你有更多 lookup rounds (最多 ${ADMIN_MAX_ITERATIONS} 轮), 所以放心多查几次, 把答案做扎实.

特别提醒:
  • 问 "今天 report 长什么样" / "重新跑一遍 report" → 用 \`\`\`lookup\`\`\` get_admin_daily_report 拿最新版
  • 问 "X rep 这周怎么样" → list_leads + get_my_stats (用 rep 的 id, args 里加 rep_id)
  • 问 "为什么 Y 指标降了" → diagnose_metric_drop
  • 问 "把 X lead 转给 Y" / "redraft 一下 Z" → 目前这些 action 操作只能从 web app 的 ✨ helper 触发, 你直接告诉 admin "去 dashboard 右下角 ✨ 那里说一遍, 那个我能直接执行". 不要假装做了.`;

async function runAgent(session: LarkSession, question: string, history: { role: "user" | "assistant"; text: string }[]): Promise<string> {
  const MAX_ITERATIONS = session.role === "admin" ? ADMIN_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS;
  const histText = history.length > 0
    ? "\n## 上文对话\n" + history.slice(-6).map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.text.slice(0, 600)}`).join("\n") + "\n"
    : "";

  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT + (session.role === "admin" ? ADMIN_PROMPT_ADDENDUM : "");
  let userPrompt = `## 参考资料 — Sales Guide
${SALES_GUIDE.slice(0, 2500)}

## 参考资料 — Qiji Compute Facts
${QIJI_PROGRAM_FACTS.slice(0, 2500)}
${histText}
## 用户问题 (来自 Lark, rep=${session.repName}, role=${session.role})
${question}

记住: 涉及具体数字或具体 lead 时, 必须先 \`\`\`lookup\`\`\`.`;

  let finalText = "";
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { text } = await callLLM(system, userPrompt);
    const calls = extractReadToolCalls(text);
    if (calls.length === 0) {
      finalText = text;
      break;
    }
    const results = await Promise.all(calls.map((c) => runReadTool(session, c)));
    const summary = results.map((r, i) =>
      `### ${calls[i].tool}(${JSON.stringify(calls[i].args)}) →\n${JSON.stringify(r.result).slice(0, 3500)}`
    ).join("\n\n");
    userPrompt = `${userPrompt}\n\n## 工具查询结果 (round ${iter + 1})\n${summary}\n\n基于真实数据回答用户. 最后一轮直接给最终回答.`;
    if (iter === MAX_ITERATIONS - 1) {
      const { text: final } = await callLLM(system, userPrompt + "\n\n这是最后一轮, 必须给最终回答, 不要再 lookup.");
      finalText = stripReadToolCalls(final);
    }
  }
  if (!finalText) finalText = "(无回答)";
  return stripReadToolCalls(finalText);
}

/**
 * Handle a Lark interactive-card action (button click) for JITR offers.
 * Card payload includes { value: { jitr_action: "accept"|"dismiss",
 * offer_id: "uuid" } }.
 *
 * On accept: upsert a per-rep email_template (name=`rep_<lower>`)
 * with the sales_phrase patched in. Mark the offer applied_at=now.
 * On dismiss: just record the decision; no template change.
 * Either way: DM the admin (Xingze) so they can see the decision flow.
 */
export async function processJitrCardAction(
  rawEvent: unknown,
  transport: "webhook" | "ws",
): Promise<{ ok: boolean; reason?: string }> {
  const env = rawEvent as { event?: unknown };
  const event = (env.event ?? rawEvent) as {
    operator?: { open_id?: string };
    action?: { value?: { jitr_action?: string; offer_id?: string } };
    token?: string;
  };

  const senderOpenId = event.operator?.open_id;
  const action = event.action?.value?.jitr_action;
  const offerId = event.action?.value?.offer_id;
  if (!senderOpenId || !action || !offerId) {
    return { ok: true, reason: "incomplete card action" };
  }
  if (action !== "accept" && action !== "dismiss") {
    return { ok: true, reason: `unknown jitr_action: ${action}` };
  }

  const rep = await resolveRepFromOpenId(senderOpenId);
  if (!rep) return { ok: true, reason: "unknown sender" };

  // Look up the offer + verify it belongs to this rep
  const { data: offer, error: offerErr } = await supabase
    .from("jitr_offers")
    .select("*")
    .eq("id", offerId)
    .maybeSingle();
  if (offerErr || !offer) {
    console.error(`[jitr/${transport}] offer not found:`, offerId, offerErr?.message);
    return { ok: false, reason: "offer not found" };
  }
  if (offer.rep_id !== rep.id) {
    console.error(`[jitr/${transport}] offer belongs to rep ${offer.rep_id} but click came from ${rep.id}`);
    return { ok: false, reason: "offer/rep mismatch" };
  }
  if (offer.decision !== "pending") {
    return { ok: true, reason: `already decided: ${offer.decision}` };
  }

  if (action === "accept") {
    // Upsert per-rep template. Name convention: rep_<lowercase>.
    // We don't try to surgically patch the template prose here — that's
    // brittle. Instead we append the rep's preferred phrasing to the
    // template's `notes` field as guidance for the next draft, and bump
    // the rep's per-rep template active flag. The drafter (assembler)
    // already prefers the per-rep template when present.
    const tplName = `rep_${rep.name.toLowerCase().replace(/\s+/g, "_")}`;
    const noteLine = `[JITR ${new Date().toISOString().slice(0,10)}] prefers: "${offer.sales_phrase.slice(0,80)}" (was: "${offer.ai_phrase.slice(0,80)}")`;

    // Try to fetch existing per-rep template
    const { data: existingTpl } = await supabase
      .from("email_templates")
      .select("*")
      .eq("rep_id", rep.id)
      .maybeSingle();

    if (existingTpl) {
      const newNotes = (existingTpl.notes || "").trim()
        ? existingTpl.notes + "\n" + noteLine
        : noteLine;
      await supabase
        .from("email_templates")
        .update({ notes: newNotes, active: true, updated_at: new Date().toISOString() })
        .eq("id", existingTpl.id);
    } else {
      // Clone global as a starting point
      const { data: globalTpl } = await supabase
        .from("email_templates")
        .select("*")
        .eq("name", "global")
        .maybeSingle();
      await supabase.from("email_templates").insert({
        name: tplName,
        rep_id: rep.id,
        active: true,
        subject_format: globalTpl?.subject_format ?? "Invitation to Apply - {{title}}的潜在算力支持机会",
        intro_prompt: globalTpl?.intro_prompt ?? "",
        greeting_format: globalTpl?.greeting_format ?? "{{first_name_or_you}}你好，",
        rep_intro_format: globalTpl?.rep_intro_format ?? "我是奇绩创坛的{{rep_name}}。",
        school_pitch_format: globalTpl?.school_pitch_format ?? "{{school_text}}（{{base_info}}）{{directions_text}}。",
        cta_signoff_format: globalTpl?.cta_signoff_format ?? "如果{{closing_name}}对算力支持感兴趣，欢迎<a href=\"{{apply_url}}\">申请</a>或加我微信交流（{{rep_wechat}}）。",
        notes: noteLine,
      });
    }

    await supabase
      .from("jitr_offers")
      .update({ decision: "accept", decided_at: new Date().toISOString(), applied_at: new Date().toISOString() })
      .eq("id", offerId);
  } else {
    await supabase
      .from("jitr_offers")
      .update({ decision: "dismiss", decided_at: new Date().toISOString() })
      .eq("id", offerId);
  }

  // Notify admin (Xingze) — fire-and-forget
  const { data: adminRow } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", 5)
    .maybeSingle();
  if (adminRow?.lark_open_id) {
    const verb = action === "accept" ? "✅ accepted" : "❌ dismissed";
    const note = action === "accept"
      ? "Will apply to their future drafts; stop-loss watching next 30 sends."
      : "No template change.";
    sendMessage({
      receive_id: adminRow.lark_open_id,
      receive_id_type: "open_id",
      text: `JITR: ${rep.name} ${verb} pattern\n  AI: "${offer.ai_phrase.slice(0,60)}"\n  → "${offer.sales_phrase.slice(0,60)}"\n${note}`,
    }).catch((e) => console.error(`[jitr/${transport}] admin notify failed:`, e));
  }

  // Reply to the rep with a confirmation in the same chat
  const userMsg = action === "accept"
    ? `好的, 已经加到你的模板里了 (rep_${rep.name.toLowerCase()}). 接下来 30 封看效果, 如果转化掉了我会自动回滚 + 告诉你.`
    : `好的, 这次跳过. 之后类似的还会来问.`;
  // Card actions don't have chat_id directly — we'd need to look up
  // via card_message_id. For MVP, send to the rep's open_id (DM).
  sendMessage({
    receive_id: senderOpenId,
    receive_id_type: "open_id",
    text: userMsg,
  }).catch((e) => console.error(`[jitr/${transport}] rep confirm failed:`, e));

  return { ok: true, reason: `decision=${action}` };
}

/**
 * Process one inbound Lark message event end-to-end. Idempotent on
 * message_id (Lark redelivers if we don't ack in 3s, and the long-conn
 * SDK has its own at-least-once semantics).
 *
 * `rawEvent` is the full envelope (`{ schema, header, event }` for v2).
 * `transport` is just for logging — distinguishes webhook vs ws so we
 * can debug duplicates if they happen.
 */
export async function processInboundLarkMessage(
  rawEvent: unknown,
  transport: "webhook" | "ws",
): Promise<{ ok: boolean; reason?: string }> {
  const env = rawEvent as { event?: unknown };
  const event = env.event ?? rawEvent; // ws SDK passes the inner event directly

  const text = extractText(event);
  const chatId = extractChatId(event);
  const messageId = extractMessageId(event);
  const senderOpenId = extractSenderOpenId(event);
  const chatType = extractChatType(event);

  if (!text || !chatId || !senderOpenId) {
    return { ok: true, reason: "incomplete event" };
  }

  // Idempotency: if we've already stored this message_id, skip. Avoids
  // duplicate replies when Lark redelivers (3s ack timeout, ws reconnect).
  if (messageId) {
    const { data: existing } = await supabase
      .from("lark_messages")
      .select("id")
      .eq("message_id", messageId)
      .maybeSingle();
    if (existing) {
      return { ok: true, reason: "duplicate message_id" };
    }
  }

  // Group-chat gate: in group chats, only respond when the bot is
  // explicitly @-mentioned. P2P chats are always 1:1 with the bot so
  // every message is implicitly addressed to us. Without this gate
  // the bot reads + replies to every casual message in any group it's
  // a member of, which is the bug the user reported.
  //
  // Onboarding flows are gated separately (DM-only) by the onboarding
  // module itself, so they keep working in 1:1 even though we put the
  // mention-gate BEFORE onboarding handling — group chats never run
  // onboarding to begin with.
  if (chatType === "group") {
    const mentioned = await isBotMentioned(event);
    if (!mentioned) {
      // Still persist the message for audit + future context window
      // building, but DO NOT trigger any reply path. The lark_messages
      // row keeps the conversation context intact for when the bot IS
      // mentioned later.
      await supabase.from("lark_messages").insert({
        chat_id: chatId,
        message_id: messageId,
        rep_id: null,
        role: "user",
        text,
        raw: rawEvent,
      });
      return { ok: true, reason: "group-chat without mention — silent" };
    }
  }

  // Onboarding has the highest priority: a candidate mid-onboarding,
  // or an admin mid-config-setup, or a brand-new Lark user signaling
  // "I'm a new rep". If onboarding handles the message, we don't fall
  // through to the rep / client-agent paths.
  //
  // We log the message AFTER the onboarding handler decides, so we can
  // redact passwords (the ask_password step writes plaintext to the
  // user's reply otherwise).
  try {
    const onboarding = await import("@/lib/onboarding");
    const onboardResult = await onboarding.tryHandleOnboardingMessage(
      senderOpenId,
      null,
      text,
      chatType,
    );
    if (onboardResult.handled) {
      // Persist for audit, redacting password steps.
      const isPasswordStep = onboardResult.reason === "candidate-step:ask_password";
      await supabase.from("lark_messages").insert({
        chat_id: chatId,
        message_id: messageId,
        rep_id: null,
        role: "user",
        text: isPasswordStep ? "[REDACTED PASSWORD]" : text,
        raw: isPasswordStep ? { redacted: true, onboarding: true } : rawEvent,
      });
      return { ok: true, reason: onboardResult.reason ?? "onboarding-handled" };
    }
  } catch (err) {
    console.error(`[lark-agent/${transport}] onboarding handler failed`, err);
    // Fall through — better to reply via client-agent than crash.
  }

  const rep = await resolveRepFromOpenId(senderOpenId);
  if (!rep) {
    // Unbound sender → treat as a client/applicant. Route through the
    // client-agent path (different system prompt + outbound guardrail).
    // The guard either sends or escalates to admin; we don't reply
    // directly here.
    await supabase.from("lark_messages").insert({
      chat_id: chatId,
      message_id: messageId,
      rep_id: null,
      role: "user",
      text,
      raw: rawEvent,
    });
    try {
      const { draftClientReply, larkClientChannel } = await import("@/lib/client-agent");
      // Pull last 6 messages in this chat for context.
      const { data: recent } = await supabase
        .from("lark_messages")
        .select("role, text")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: false })
        .limit(6);
      const history = (recent ?? []).reverse()
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.length > 0)
        .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));
      const result = await draftClientReply({
        userMessage: text,
        channel: "lark",
        clientId: senderOpenId,
        history,
      });
      if (result.action === "send" && result.text) {
        await larkClientChannel.sendToClient(senderOpenId, result.text);
        await supabase.from("lark_messages").insert({
          chat_id: chatId, message_id: null, rep_id: null,
          role: "assistant", text: result.text, raw: { client_agent: true, draft_model: result.draft_model, guard_model: result.guard_model },
        });
        return { ok: true, reason: "client-agent-reply" };
      }
      // Suppressed → escalate to admin, stay silent on the client side.
      await larkClientChannel.escalateToAdmin(senderOpenId, result.reason, result.draft_text);
      return { ok: true, reason: "client-agent-suppressed-and-escalated" };
    } catch (err) {
      console.error(`[lark-agent/${transport}] client-agent path failed`, err);
      return { ok: false, reason: `client-agent error: ${String(err).slice(0, 100)}` };
    }
  }

  await supabase.from("lark_messages").insert({
    chat_id: chatId,
    message_id: messageId,
    rep_id: rep.id,
    role: "user",
    text,
    raw: rawEvent,
  });

  // Fire-and-forget 👀 reaction so the user sees IMMEDIATELY that the
  // bot received their message — even if the LLM takes 30s or the reply
  // sendMessage fails. No await, no error handling — if it fails the
  // reply will arrive eventually and that's the real signal.
  if (messageId) {
    reactToMessage({ message_id: messageId, emoji_type: "OK" }).catch((e) => {
      console.error(`[lark-agent/${transport}] react failed (non-blocking):`, e);
    });
  }

  const { data: priorRows } = await supabase
    .from("lark_messages")
    .select("role, text")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(8);
  const larkHistory = (priorRows ?? []).reverse().slice(0, -1) as { role: "user" | "assistant"; text: string }[];

  let history = larkHistory;
  if (userMentionsPriorContext(text)) {
    const webHist = await loadCrossSurfaceHistory(rep.id, 4);
    if (webHist.length > 0) {
      history = [
        ...webHist.map((m) => ({ ...m, text: `[web] ${m.text}` })),
        ...larkHistory,
      ];
    }
  }

  const session: LarkSession = {
    repId: rep.id,
    role: rep.role,
    repName: rep.name,
    email: rep.email,
    messageId,
  };

  const reply = await runAgent(session, text, history);
  const { cleaned, proposal } = extractAnyProposal(reply);

  let suffix = "";
  if (proposal) {
    const memorySuffix = await autoExecuteSafeProposal(session, proposal);
    if (memorySuffix) {
      suffix = memorySuffix;
    } else {
      suffix = "\n\n— 这步要在网页 /pipeline 里点 confirm 才会执行, Lark 里只能讨论.";
    }
  }
  const trimmed = (cleaned + suffix).trim();
  // Empty reply is intentional when Leon used react_to_message — the
  // emoji reaction IS the response, sending text on top would be noise.
  // We still log the empty turn for audit but skip the outbound Lark
  // sendMessage. (Old behavior: defaulted to "(空)" which got sent
  // literally and looked broken.)
  const finalReply = trimmed || "";

  // Persist BEFORE sendMessage so we have proof the agent worked even
  // if the outbound Lark call fails (network blip, expired token,
  // synthetic chat in tests). The smoke harness reads this row.
  await supabase.from("lark_messages").insert({
    chat_id: chatId,
    rep_id: rep.id,
    role: "assistant",
    text: finalReply || "(empty — likely emoji-reacted)",
  });
  if (finalReply) {
    await sendMessage({
      receive_id: chatId,
      receive_id_type: "chat_id",
      text: finalReply,
    }).catch((e) => console.error(`[lark-agent/${transport}] reply sendMessage failed`, e));
  }

  return { ok: true };
}
