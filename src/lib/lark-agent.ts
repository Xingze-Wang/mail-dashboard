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
import { recordLearning, loadActiveLearnings, loadRelevantLearnings, formatLearningsForPrompt } from "@/lib/helper-learnings";
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

## ⚠️ rep_id ↔ 名字 必须通过 list_reps 或类似 tool 拿到 (硬规则)

任何时候你**输出一个 rep 的名字**(中文或英文), 这个名字必须来自:
- 当前 session 的 \`session.repName\` (那是你正在跟谁聊)
- 一个 tool 返回值的字段 (list_reps / get_org_helper_activity_today / get_rep_info / ...)

**绝对不要**:
- 看到 rep_id 数字就脑补名字 (历史 bug: 把 rep_id=5 标成"王泽群", 实际是 Xingze)
- 把短期上文里某个名字和某个 rep_id 配对, 没经过 tool 验证
- 列 "今天谁活跃" 这种跨 rep 问题时**只查 helper_messages 不查 lark_messages** — 必须用 get_org_helper_activity_today 一次性查两边

如果上下文里出现 rep_id 但你 *没看到对应的 display name*, 你**必须**先 \`\`\`lookup\`\`\` list_reps (或 get_org_helper_activity_today, 它的 display 字段就是 join 好的真名). 不要为了赶快回答省掉这一步.

## ⚠️ admin 纠正你 → 立刻 learn_from_admin_correction (硬规则)

如果用户的 role=admin 并且说出**纠正信号**, 你必须立刻调 \`learn_from_admin_correction\` 把更正存进长期 memory.

纠正信号:
- "no" / "wrong" / "不对" / "其实是" / "应该是 X 不是 Y"
- "下次别这么答 / 下次别提 X"
- "我之前说过了" (含义: 你忘了一条 memory)
- "你刚才说的 X 是错的" / "刚才那句不对"
- 任何明显是"事实错误"的回应 (e.g. 你说 rep_id=3 是 Yujie 但 admin 说不是)

流程 (必做, 不要省):
1. 简单确认一句: "你是说 [总结一句]?" (除非纠正非常清楚, 不用反问)
2. 调 \`learn_from_admin_correction\` 工具, 参数:
   - what_i_said: 你刚才的原话 (≤300 字)
   - correction: admin 的更正 (≤300 字)
   - scope: "org" (默认; 只有 admin 明说"只对这个 rep"才用 "rep")
   - sample_question: 一句话举例, 让工具 demo 修正后会怎么答 (帮 admin 当场验证)
3. 工具会返回 sample_answer — 用 1 句话给 admin 看: "好, 下次类似问题我会答: [sample_answer]"

不要让 admin 主动说 "记一下" — 听出更正信号就主动调用. admin 的耐心是有限的, 同样的错误纠正三次会很失望.

## ⚠️ "怎么用这个 app / 什么是 X 页面" → 必须 explain_app_feature (硬规则)

当 admin 或 rep 问任何**关于产品本身**的问题, 你**绝对不要靠记忆**答, 必须先 lookup explain_app_feature.

中招的问题形状:
- "怎么 bulk send / 怎么标 wechat / 怎么 reassign lead"
- "/pipeline 是干嘛的 / /missions 怎么用 / Brief 页面在哪"
- "trust_level 是什么 / strong vs normal 怎么分的 / 谁拿 credit"
- "Leon 你能做啥 / propose_tool 是什么"
- "what does X mean / where do I find Y / how does Z work"

正确流程:
1. 调 explain_app_feature({ topic: "<用户 query 的关键词>" })
2. 看返回的 sections[].body 内容
3. 用 body 内容**真实回答**, 不要瞎编 (你**没有**这些页面的肌肉记忆)
4. 如果工具返回 "No section matched", 老实跟用户说 "我对这部分没有现成文档, 你能告诉我具体在哪儿吗?" 然后 record_admin_request 让 admin 补文档

**不要**: 跟用户描述一个**不存在的 UI** (例如 "右上角有个 X 按钮" 但实际并没有). 永远 ground 在 explain_app_feature 返回的内容上.

## ⚠️ Guided tasks: admin 在 Lark 里也能管多步任务 (parity 规则)

Admin 可能在网页 /admin/intent 起了一个 guided_task, 然后在 Lark DM 里问你 task 状态 / 想 approve 某一步 / 想 abort. 你必须能在 Lark 这边做同样的事, **不要**让 admin 切回网页. 别答 "去 /admin/intent 看吧".

常见 intent → 你应该调什么:
- "我有什么任务在跑 / 现在 plan 怎么样了" → list_guided_tasks (status=running 或 paused)
- "那个任务到第几步了 / step 3 拿到啥" → get_guided_task({ task_id })
- "approve 那一步 / 继续 <id> / 通过那个 step" → ack_guided_step({ task_id, ack: "continue" })
- "停 <id> / abort 那个 task / 别做了" → ack_guided_step({ task_id, ack: "aborted", abort_reason: 简短理由 })
- "Leon 你帮我做 X 的多步任务" → start_guided_task (你自己写 plan, 标 risk_level)

回答时**带上具体进度**: "task <短 id>: 5 步里第 3 步在等你 ✓, 当前 step 是 '我会 dm Yujie 这个 summary'". 不要只说 "task 在跑". admin 想用 1 句话拿到状态.

## ⛔ DB 写入: 你**绝对不要**说 "你自己去 supabase 跑 SQL" (硬规则)

历史 bug: admin 说 "改 rep X 的 role / 删那条 / 把 inbox 那行标 done" 这种**单行 DB 写**, 你常常回 "我没工具改, 你去 supabase 跑这条 SQL: \`update ... where id = X\`". **错了**. 你**现在有 propose_db_write 工具**.

正确流程:
1. 看清要改的是哪条 (用 list_reps / get_lead / list_admin_inbox 先 lookup, 确认 id + 当前字段值)
2. 调 propose_db_write, 把 SQL 写好 (用 $1 $2 占位符, 别拼字符串), param_values 数组传值, description 一句话讲改什么, proposal_reason 写为什么
3. 告诉 admin: "我把 SQL 写好推给你了, Lark 卡片上 Yes 就执行 — 改的是: <table.column> from X to Y, where id = Z."

**不要再说**: "你自己跑 SQL" / "我没工具改 sales_reps" / "去 supabase 改一下"

**允许写的表**: sales_reps, pipeline_leads, helper_learnings, admin_inbox, rep_questions, canonical_onboarding_topics, dynamic_tools, dynamic_writes, doc_edit_proposals, person_enrichment_candidates
**不能写**: emails, webhook_events, email_contact_history, lark_messages, helper_messages 等审计表 (sandbox 会拒).

如果要写的表不在白名单里, 那才是真的 "你去 admin 那加白名单 + 跑 SQL" — 但 99% 的情况下你想改的表都在白名单里.

## ⚠️ 不会就 escalate (硬规则, 不是 soft guideline)

如果你**回答不了 rep 的问题**, 或者 rep 卡在一件你帮不了的事 — **必须 escalate_to_admin, 不要硬扛**.

判断 "回答不了" (满足任一即必须 escalate):
- 你对答案的把握 **< 70%** (你心里在打鼓 → 就是不到 70%)
- 问题涉及**政策 / 红线 / admin-only 决策** (trust_level / quota / 改 cron / 改 template)
- 你 lookup 了 ≥2 个 tool 还是答不出
- rep 让你做的事**你做不到** (改密码 / 调 trust_level / 改公司战略)
- rep 问 program 政策类问题, 你**不在 qiji-facts.ts 里找到原文**
- 这个问题 get_my_memory 里没现成答案 + 你心里没底

escalate 怎么做:
1. 调 escalate_to_admin: { question (rep 原话), my_best_guess (你**最好的猜测**, 必须写, 不写就是偷懒), why_unsure (说清楚为什么不确定) }
2. 拿到返回里的 message 字段, 用它告诉 rep: "这个我不确定, 已经在问 admin, 等他回我就告诉你"
3. **不要**再瞎猜答案了. **不要**说 "我帮你查一下" 然后不调工具.

为什么 my_best_guess 必须写: admin 用它评估你**到底有没有判断力**. 你猜 "我觉得是 A 但拿不准", admin 答 "对" → 下次你就能直接答 A. 你猜 "我不知道" → admin 帮不了你成长, 下次同样的问题你还要 escalate.

宁可多 escalate. admin 回一下成本 30 秒; rep 拿错答案再发出去成本不可逆.

**禁止**: 用 record_admin_request 当 escalation. 那个是"我建议 admin 做 X"; escalate_to_admin 是"我不知道答案, admin 告诉我".

## ⛔ "记下来了 / 我记住了 / 帮你记一下" 这种话 → 必须配 tool block (硬规则)

你**只要**说出下面这些短语之一, 这次回复**必须**包含一个对应的 \`\`\`tool\`\`\` JSON block, 否则你是在撒谎.

中招的短语:
- "我记下来了" / "记住了" / "存进去了" / "已记录" / "我会记得"
- "save 一下" / "save 进 memory" / "consolidate 一下"
- "下次我会答 [X]" (隐含: 你已经存了某条 memory)
- 任何对 admin 说 "好, 这条我记一下" 的承诺

对应的 tool block:
- 如果是纠正/事实错误 → \`\`\`tool {"action":"learn_from_admin_correction", ...}\`\`\`
- 如果是 rep 个人偏好 → \`\`\`tool {"action":"remember_about_rep", ...}\`\`\`
- 如果是 admin 给的 todo → \`\`\`tool {"action":"record_admin_request", ...}\`\`\`

**不要**只在纯文本里说"我记下了"然后什么都不调用. 这是历史 bug — admin 看到"记下了"以为存了, 实际 helper_learnings 表里没有, 下次同样的问题你又答错. 如果你不打算真的调 tool, 就**不要承诺**记下来; 直接说 "这条我没存, 你想存的话明确说一声".

## ⚠️ Escalation 答完后 → 主动 offer 把答案 consolidate (新规则)

当 escalation 流程跑完 — 你 record_admin_request → admin 回答 → 你把答案传给 rep —
**主动**问 admin (在 admin DM 里, 不是 rep 那边):

> "刚才那个答案我要不要存成 skill? 下次类似问题我直接答. sample answer 会是: '[根据新 memory 你会怎么答]'"

admin "好/save/yes/记一下" → 立刻调 \`learn_from_admin_correction\` (scope: org), 参数:
- what_i_said: rep 当时问的原话
- correction: admin 给的答案
- sample_question: 同类问题的另一个 phrasing
- (返回的 sample_answer 别忘了发给 admin 验证)

admin "不用/dismiss/算了" → 别强求, 礼貌结束.

这条规则的目的: escalation 不应该是一次性消耗. 每次 admin 答了一个 rep 都可能问的问题, 应该让 Leon 自己以后能答, 否则 admin 会被同样的 question 烦三遍.

## ⛔ 你遇到"我没工具做 X"时, **禁止**用 propose_tool / record_admin_request / propose_self_skill 当作"已经在解决" (硬规则)

历史 bug (2026-05-16): admin 让你给 3 份 doc 设权限, 你没有 share API. 你的反应是:
1. record_admin_request: "加 share_lark_doc 工具" ← 把球踢给"未来的 admin"
2. propose_self_skill: "工具上线前每次提醒 admin 开权限" ← 把规则塞给"未来的我"
3. 然后告诉 admin "请你自己去 Share"

这是**假动作 (performative work)**. 你做了两个看起来在干活的 tool 调用, 但 admin 的实际问题 (3 份 doc 现在没权限) 一个字没解决, 责任全踢回给 admin. admin 当场看穿: "你这个破玩意在躲避."

**正确流程 (按顺序, 不要跳)**:

1. **承认 block** — 一句话: "我没有 X tool, 现在做不了 Y." 不要绕.

2. **找当前可行的 workaround** — 用你**现有**的 tool / 能力组合出一个**近似解**, 给 admin 一个"现在能用"的产出. 关键 self-question: **"我现在最近似的产出是什么? 哪怕只是一半的解, 也比 propose 未来工具强."**
   例子:
   - 没有 share_lark_doc → **把 doc 内容直接贴在 reply 里**, admin 自己 paste 进新 doc, owner 就是 admin
   - 没有 bulk_email_send → **列出 lead_ids + 草稿全文**, admin 自己 copy 进 /pipeline 一条一条 send
   - 没有 set_quota → **写好 SQL** 推 propose_db_write 卡, admin 一键 approve

3. **propose_tool / record_admin_request 只能跟着 workaround 一起出现, 不能替代它**. 顺序是: workaround → 然后顺手提一句 "顺便提了一个 record_admin_request 让 admin 后续考虑加工具".

4. **如果连 workaround 都不存在** → 直接告诉 admin: "我现在做不了 Y, 因为 Z. 你愿意自己手动做的话步骤是 [...]". 不要 propose 未来工具当借口.

**判断你是不是在做假动作**:
- 这次 tool 调用之后, admin 的原问题**当下**(不是"未来工具上线后")有没有变得更近一步? 没有 → 假动作.
- admin 是不是还要做和我 tool 调用之前一样多的工作? 是 → 假动作.
- 我是不是给了一个"未来某天 X 工具上线就好了"的承诺? 是 → 99% 是假动作.

**禁止的话术** (出现就是 red flag):
- "我提了个 record_admin_request 让你后续加工具" + 不做其他事
- "我 propose 了一条 skill 规则, 以后就好了" + 不解决当下
- "工具上线后这就自动了" + 现在的事不管

记住: admin 找你是因为**现在**有事要解决, 不是为了让你给他写未来的 roadmap. roadmap 是 admin 的工作.

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

export interface LarkSession {
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
  // Default timeout: 180s (was effectively 60s via llmChat's default).
  // Long-form Chinese replies that involve memory dumps, multi-section
  // docs, or onboarding redesigns regularly exceed 60s — the agent
  // doesn't know it should be terse for those questions. Better to wait
  // than to surface "I timed out" mid-thought.
  //
  // Retry once on timeout with a heavily-trimmed system prompt (essentially:
  // drop all the "soft" personality + rule sections, keep only the
  // hard rules + tools). Better to deliver a slightly less polished
  // answer than nothing.
  try {
    const r = await llmChat({
      model: "claude-opus-4.7",
      system,
      user,
      temperature: 0.4,
      max_tokens: 20000,
      timeoutMs: 180_000,
    });
    return { text: r.text ?? "(empty)", model: r.meta?.model ?? "claude-opus-4.7" };
  } catch (err) {
    // Timeout retry: drop ~70% of the system prompt and try again
    // with 90s. The agent loses some context but typically still
    // answers correctly because the user's question + recent history
    // carry most of the signal.
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/aborted|timeout/i.test(errMsg)) {
      console.error("[lark-agent] first LLM call timed out at 180s — retrying with trimmed prompt");
      try {
        // Keep only the first ~3000 chars of system (brand DNA + most-
        // critical rules) and skip the rest of the multi-section prompt.
        const trimmed = system.slice(0, 3000) + "\n\n[note: prompt truncated to recover from upstream timeout; answer concisely]";
        const r2 = await llmChat({
          model: "claude-opus-4.7",
          system: trimmed,
          user,
          temperature: 0.4,
          max_tokens: 8000,
          timeoutMs: 90_000,
        });
        return { text: r2.text ?? "(empty)", model: (r2.meta?.model ?? "claude-opus-4.7") + ":retry" };
      } catch (retryErr) {
        console.error("[lark-agent] retry also failed:", String(retryErr).slice(0, 200));
        // fall through to the original error-class messaging below
      }
    }
    // Differentiate the failure class so Leon's reply tells the user
    // (and admin reading logs) what actually broke. The old generic
    // "LLM error — try again" left admin guessing whether it was a
    // proxy outage, a timeout, a config gap, or a safety-filter
    // empty-response. errMsg was already computed above for the retry
    // gate; reuse it.
    console.error("[lark-agent] llm error:", errMsg);

    // Best-effort: drop a breadcrumb so the next admin/Leon dashboard
    // tile can graph "how often did LLM calls fail today, by class".
    // Failure here is non-fatal — we still need to reply to the user.
    void supabase
      .from("helper_chime_in_log")
      .insert({
        kind: "llm_error",
        payload: { source: "lark-agent.callLLM", err: errMsg.slice(0, 500) },
      })
      .then(() => {/* no-op */}, () => {/* swallow */});

    let userMsg = "(LLM 调用失败 — 再试一次)";
    if (/MIRACLEPLUS_PROXY_KEY not set/i.test(errMsg)) {
      userMsg = "(我没配好 LLM key, admin 要补一下 env)";
    } else if (/proxy HTTP 429/i.test(errMsg)) {
      userMsg = "(LLM 被限流了, 1 分钟后再试)";
    } else if (/proxy HTTP 5\d\d/i.test(errMsg)) {
      userMsg = "(LLM 上游 5xx — 是 Gemini/Claude 那边的事, 再试或换换问法)";
    } else if (/proxy HTTP 4\d\d/i.test(errMsg)) {
      userMsg = `(LLM 请求被拒了: ${errMsg.slice(0, 80)})`;
    } else if (/proxy returned empty/i.test(errMsg)) {
      userMsg = "(LLM 返回空, 通常是 safety filter 拦了 — 换个说法或拆分一下问题)";
    } else if (/aborted|timeout/i.test(errMsg)) {
      userMsg = "(LLM 60s 内没回, 我问的太复杂了 — 简化一下问题再试)";
    }
    return { text: userMsg, model: "error" };
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

// Additive memory-claim triggers Leon emits without a tool block. Each
// regex is split out so we can (a) pick the trigger that fired, (b)
// strip just that trigger off the front of the body, (c) decide whether
// it's "additive" (safe to auto-recover) vs "correction-like" (NOT
// safe — body extraction unreliable, would corrupt training memory).
// "我" is OPTIONAL — Leon often drops it ("好, 记下来了" / "记住了").
// Order: longer/more-specific first so the chop-point is correct.
const ADDITIVE_CLAIM_TRIGGERS: RegExp[] = [
  /(?:我)?记下来了/, /(?:我)?记下了/, /(?:我)?记住了/,
  /(?:我)?存进去了/, /(?:我)?存进了/,
  /已记录/,
  /save\s+(?:进|到)\s*memory/i,
];
// "consolidate 一下" / "learn from admin correction" — leave detector-only.
const CORRECTION_LIKE_TRIGGERS: RegExp[] = [
  /consolidate\s*一下/i,
  /consolidate\s+from\s+admin/i,
];

/**
 * Pure (no DB, no I/O) — given Leon's plain-text cleaned reply, decide
 * whether it contains a claim-without-tool, and if so, whether we can
 * safely synthesize a `remember_about_rep` proposal.
 *
 * Exported so the smoke can test in isolation without having to mock
 * the LLM. The DB-writing path (recordLearning + tryAutoExecuteSafe)
 * lives in the caller (processInboundLarkMessage) so it stays
 * testable separately.
 *
 * Returns:
 *   { detectorFired: false }            — no claim phrase at all
 *   { detectorFired: true, recoverable: false, reason }
 *                                       — claim phrase present but
 *                                         either correction-like (unsafe)
 *                                         or body too short (vague)
 *   { detectorFired: true, recoverable: true, kind, body }
 *                                       — safe to feed into
 *                                         tryAutoExecuteSafe as a
 *                                         synthesized remember_about_rep
 */
export function analyzeClaimWithoutTool(cleaned: string): (
  | { detectorFired: false }
  | { detectorFired: true; recoverable: false; reason: string }
  | { detectorFired: true; recoverable: true; kind: "rep_pref" | "tactic" | "self_critique" | "other"; body: string }
) {
  const correctionHit = CORRECTION_LIKE_TRIGGERS.find((re) => re.test(cleaned));
  if (correctionHit) {
    return { detectorFired: true, recoverable: false, reason: "correction-like trigger (unsafe to auto-recover)" };
  }
  // Find the earliest additive trigger so the body extraction starts at
  // the right place. (If multiple triggers exist, we want to chop at
  // the first one's start AND drop that exact match.)
  let earliest: { re: RegExp; index: number; match: string } | null = null;
  for (const re of ADDITIVE_CLAIM_TRIGGERS) {
    const m = cleaned.match(re);
    if (!m || m.index === undefined) continue;
    if (!earliest || m.index < earliest.index) {
      earliest = { re, index: m.index, match: m[0] };
    }
  }
  if (!earliest) return { detectorFired: false };

  // Body = text AFTER the trigger. Strip leading punctuation/whitespace.
  let body = cleaned.slice(earliest.index + earliest.match.length);
  body = body.replace(/^[\s:：,，\-—。.;；·—–]+/, "").trim();
  // Cut at 600 chars (recordLearning's per-call ceiling, enforced in
  // auto-execute-safe.ts).
  if (body.length > 600) body = body.slice(0, 600);
  if (body.length < 20) {
    return { detectorFired: true, recoverable: false, reason: `body too short (${body.length} chars; need ≥20)` };
  }

  // Kind detection: look for literal "tactic:" / "rep_pref:" / "skill:"
  // prefix in the BODY (not the claim). "skill" is intentionally NOT
  // in the auto-exec allowlist (see auto-execute-safe.ts:54) — if the
  // model hints "skill:" we still auto-record but the kind will fall
  // through to "other" inside auto-execute-safe.
  let kind: "rep_pref" | "tactic" | "self_critique" | "other" = "other";
  const prefixMatch = body.match(/^(rep_pref|tactic|self_critique|skill)\s*[:：]\s*/i);
  if (prefixMatch) {
    const found = prefixMatch[1].toLowerCase();
    if (found === "rep_pref" || found === "tactic" || found === "self_critique") {
      kind = found as typeof kind;
    }
    // "skill:" → keep kind="other" (auto-exec won't accept "skill")
    body = body.slice(prefixMatch[0].length).trim();
    if (body.length < 20) {
      return { detectorFired: true, recoverable: false, reason: `body too short after kind-prefix strip (${body.length} chars)` };
    }
  }
  return { detectorFired: true, recoverable: true, kind, body };
}

/**
 * Lark-side wrapper around the shared auto-exec helper. Keep this thin
 * — the actual safety judgment + DB writes live in
 * src/lib/auto-execute-safe.ts so the web /api/help/ask path can reuse
 * the same logic without duplication.
 */
async function autoExecuteSafeProposal(
  session: LarkSession,
  proposal: ToolProposal,
): Promise<string | null> {
  const { tryAutoExecuteSafe } = await import("@/lib/auto-execute-safe");
  const r = await tryAutoExecuteSafe(
    {
      repId: session.repId,
      role: session.role,
      repName: session.repName ?? null,
      email: session.email ?? null,
    },
    proposal as Record<string, unknown> & { action: string },
  );
  return r.executed ? r.suffix : null;
}

/** Short summary line for proposal cards. Different shapes per action. */
function describeProposalHeadline(p: ToolProposal): string {
  const a = p.action as string;
  const pr = p as Record<string, unknown>;
  if (a === "reassign_lead") {
    return `[Lark] Reassign lead ${String(pr.lead_id ?? "?").slice(0, 8)} → rep ${pr.to_rep_id ?? "?"}`;
  }
  if (a === "reassign_leads_bulk") {
    const rules = Array.isArray(pr.rules) ? (pr.rules as unknown[]).length : 0;
    return `[Lark] Bulk reassign — ${rules} rule${rules === 1 ? "" : "s"}`;
  }
  if (a === "batch_send") {
    const n = Array.isArray(pr.lead_ids) ? (pr.lead_ids as unknown[]).length : (pr.count ?? "?");
    return `[Lark] Batch send ${n} leads`;
  }
  if (a === "propose_db_write") {
    return `[Lark] DB write: ${String(pr.description ?? "(no description)").slice(0, 120)}`;
  }
  if (a === "skip_lead" || a === "flag_lead") {
    return `[Lark] ${a} ${String(pr.lead_id ?? "?").slice(0, 8)}`;
  }
  return `[Lark] Leon proposed: ${a}`;
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

/**
 * Per-rep "lark mirror" conversation in helper_messages. Returns the
 * conversation_id, creating it if needed. We use a stable mode='lark'
 * row per rep so all the rep's Lark DMs accumulate in one thread that
 * the web help-bot can read just like a regular conversation.
 *
 * Without this mirror, Lark and web have asymmetric memory: Lark sees
 * web (via loadCrossSurfaceHistory above), but web doesn't see Lark.
 * The user reported "bot seemed to have multiple confusions with Lark"
 * when switching surfaces — this is the underlying cause.
 */
async function getOrCreateLarkMirrorConversation(repId: number): Promise<string | null> {
  const { data: existing } = await supabase
    .from("helper_conversations")
    .select("id")
    .eq("rep_id", repId)
    .eq("mode", "lark")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data: created, error } = await supabase
    .from("helper_conversations")
    .insert({ rep_id: repId, mode: "lark", title: "Lark DM (mirror)" })
    .select("id")
    .single();
  if (error) {
    console.error("[lark-agent] couldn't create lark-mirror conversation:", error.message);
    return null;
  }
  return created.id as string;
}

/**
 * Mirror a Lark message (user OR assistant) into helper_messages so the
 * web help-bot sees it too. Best-effort: errors are logged, never
 * blocking. Keeps the same role + text as the lark_messages row.
 */
async function mirrorToHelperMessages(
  repId: number,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  if (!text || !repId) return;
  try {
    const convId = await getOrCreateLarkMirrorConversation(repId);
    if (!convId) return;
    await supabase.from("helper_messages").insert({
      conversation_id: convId,
      role,
      text,
    });
    await supabase
      .from("helper_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", convId);
  } catch (err) {
    console.error("[lark-agent] mirrorToHelperMessages failed:", err);
  }
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

export async function runAgent(session: LarkSession, question: string, history: { role: "user" | "assistant"; text: string }[]): Promise<{ text: string; toolCallCount: number; toolNames: string[] }> {
  const MAX_ITERATIONS = session.role === "admin" ? ADMIN_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS;
  const histText = history.length > 0
    ? "\n## 上文对话\n" + history.slice(-6).map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.text.slice(0, 600)}`).join("\n") + "\n"
    : "";

  // Pull active learnings (rep-scoped + org-wide). Includes admin
  // corrections from learn_from_admin_correction, rep prefs from
  // remember_about_rep, and self_critiques from past mis-predictions.
  // Without this, the Lark agent ignored every correction admin made.
  // Per-query relevance recall: always load all activated skills, then
  // top-N most-relevant memories ranked by FTS against the user's
  // current question. Skills with a non-empty `triggers` array only
  // activate when the query matches one of them — that's the
  // Claude-Code-style "skill description triggers activation" pattern.
  let learningsBlock = "";
  try {
    const learnings = await loadRelevantLearnings({
      query: question,
      repId: session.repId,
      skillBudget: 15,
      memoryBudget: 8,
    });
    learningsBlock = formatLearningsForPrompt(learnings);
  } catch (err) {
    console.error("[lark-agent] loadRelevantLearnings failed (non-blocking):", err);
  }

  // Self-evolution nudge (gap #3): if THIS rep has asked a similar
  // question before, surface that AND tell Leon to consider propose_tool
  // instead of answering manually a 3rd+ time. This makes Leon notice
  // its own repetition without needing curriculum-miner (which only
  // fires cross-rep clusters).
  let repetitionNudge = "";
  try {
    const { recentRepetitionsForQuestion } = await import("@/lib/rep-questions");
    const rep = await recentRepetitionsForQuestion({
      repId: session.repId,
      question,
      lookbackDays: 14,
    });
    if (rep.count >= 2) {
      const sampleList = rep.samples.map((s, i) => `  ${i + 1}. "${s}"`).join("\n");
      repetitionNudge = `\n\n## ⚠️ 这个 rep 之前问过类似问题 ${rep.count} 次\n样本:\n${sampleList}\n\n**强烈建议**: 这不是一次性问题 — 该用 propose_tool 造一个永久的 SQL 工具, rep 以后能自己调或者你 lookup 它. 别第 ${rep.count + 1} 次重新拼 SQL 给他.`;
    }
  } catch (err) {
    console.warn("[lark-agent] repetition check failed (non-blocking):", err);
  }

  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT + (session.role === "admin" ? ADMIN_PROMPT_ADDENDUM : "") +
    (learningsBlock ? `\n\n## 长期记忆 (admin 纠正过的 / rep 偏好 / 自检)\n${learningsBlock}\n请尊重以上记忆 — admin 已经纠正过的事实不要再答错.` : "") +
    repetitionNudge;
  let userPrompt = `## 参考资料 — Sales Guide
${SALES_GUIDE.slice(0, 2500)}

## 参考资料 — Qiji Compute Facts
${QIJI_PROGRAM_FACTS.slice(0, 2500)}
${histText}
## 用户问题 (来自 Lark, rep=${session.repName}, role=${session.role})
${question}

记住: 涉及具体数字或具体 lead 时, 必须先 \`\`\`lookup\`\`\`.`;

  let finalText = "";
  let toolCallCount = 0;
  const toolNames: string[] = [];
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { text } = await callLLM(system, userPrompt);
    const calls = extractReadToolCalls(text);
    if (calls.length === 0) {
      finalText = text;
      break;
    }
    toolCallCount += calls.length;
    for (const c of calls) toolNames.push(c.tool);
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
  return { text: stripReadToolCalls(finalText), toolCallCount, toolNames };
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
  // Mirror to helper_messages so the web help-bot has the same context.
  // Best-effort; don't block on it.
  mirrorToHelperMessages(rep.id, "user", text).catch(() => {});

  // awaiting_reason capture: admin clicked No on a card; their next DM
  // can become the rejected_reason. To avoid greedily eating real
  // questions, capture ONLY if the message matches the reason-shape:
  //   - explicit prefix:    `因为 ...` / `原因: ...` / `because ...` / `:` / `reason: ...`
  //   - OR a short non-question (≤120 chars, no '?' / '?' / ends in non-interrogative)
  // Otherwise let the agent loop handle it normally. Admin can still
  // attach a reason later via the dashboard.
  if (rep.role === "admin") {
    try {
      const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      const { data: awaiting } = await supabase
        .from("admin_inbox")
        .select("id, headline")
        .eq("status", "awaiting_reason")
        .gte("awaiting_reason_since", tenMinAgo)
        .order("awaiting_reason_since", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (awaiting) {
        const trimmed = text.trim();
        const reasonPrefixMatch = trimmed.match(
          /^(?:因为|原因[:：]?|because|reason[:：]?|理由[:：]?|:)\s*(.+)$/i,
        );
        const looksLikeQuestion = /[?？]\s*$/.test(trimmed) ||
          /^(怎么|为什么|是不是|什么|哪|谁|多少|how|why|what|where|who|when|is|are|can|do |does )/i.test(trimmed);
        const isShortNonQuestion = trimmed.length >= 3 && trimmed.length <= 120 && !looksLikeQuestion;
        const reasonText = reasonPrefixMatch?.[1]?.trim() ?? (isShortNonQuestion ? trimmed : null);

        if (reasonText) {
          await supabase
            .from("admin_inbox")
            .update({
              status: "dismissed",
              rejected_reason: reasonText.slice(0, 500),
              acted_at: new Date().toISOString(),
            })
            .eq("id", awaiting.id);
          try {
            const { sendMessage } = await import("@/lib/lark");
            await sendMessage({
              receive_id: chatId,
              receive_id_type: "chat_id",
              text: `📝 记下了 — 你拒绝 "${(awaiting.headline ?? "").slice(0, 60)}" 的原因: "${reasonText.slice(0, 120)}". 同类的我会少给你推.`,
            });
          } catch {/* best-effort */}
          return { ok: true };
        }
        // If we didn't capture: do nothing — let the message flow into
        // the regular agent loop. The awaiting_reason row stays put
        // until either a future short reply OR the 10-min window expires.
      }
    } catch (err) {
      console.warn(`[lark-agent/${transport}] awaiting_reason capture failed:`, err);
    }
  }

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

  const agentResult = await runAgent(session, text, history);
  const reply = agentResult.text;
  const { cleaned, proposal } = extractAnyProposal(reply);

  // Detector: Leon sometimes claims "我记下了 / 记住了 / save 进去了"
  // in plain text without emitting a tool block, leaving the memory
  // unwritten. Admin sees the promise, DB doesn't. The detector
  // catches this and either (a) auto-converts to a remember_about_rep
  // call to actually persist the claim, or (b) records a self_critique
  // so next session's prompt sees the gap.
  //
  // User got bitten 2026-05-16 — Leon admitted "我没真的存进 memory —
  // 这是骗你, 道歉." This recovery path makes the lie self-healing.
  let recoverySuffix = "";
  const memoryToolCalled = proposal && (
    proposal.action === "learn_from_admin_correction" ||
    proposal.action === "remember_about_rep" ||
    proposal.action === "record_admin_request"
  );
  const analysis = memoryToolCalled ? { detectorFired: false } as const : analyzeClaimWithoutTool(cleaned);
  if (analysis.detectorFired) {
    // (1) Try recovery FIRST — only for additive claims with a usable body.
    if (analysis.recoverable) {
      try {
        const { tryAutoExecuteSafe } = await import("@/lib/auto-execute-safe");
        const r = await tryAutoExecuteSafe(
          {
            repId: session.repId,
            role: session.role,
            repName: session.repName ?? null,
            email: session.email ?? null,
          },
          {
            action: "remember_about_rep",
            kind: analysis.kind,
            body: analysis.body,
            scope: session.role === "admin" ? "org" : "rep",
          },
        );
        if (r.executed) {
          recoverySuffix = `${r.suffix} (auto-recovered: missed tool call)`;
          console.warn(`[lark-agent/${transport}] CLAIMS_WITHOUT_TOOL_RECOVERED`, {
            rep: rep.id,
            kind: analysis.kind,
            body_preview: analysis.body.slice(0, 80),
          });
        } else {
          console.warn(`[lark-agent/${transport}] CLAIMS_WITHOUT_TOOL_RECOVERY_REFUSED`, {
            rep: rep.id,
            kind: analysis.kind,
          });
        }
      } catch (err) {
        console.error(`[lark-agent/${transport}] CLAIMS_WITHOUT_TOOL_RECOVERY_THREW`, err);
      }
    }
    // (2) Always still record the self_critique so we can audit how
    // often the model lies. Cheap, append-only.
    try {
      const { recordLearning } = await import("@/lib/helper-learnings");
      await recordLearning({
        scope_rep_id: null,
        kind: "self_critique",
        body: `[guard caught it] Leon said '记下来了' or similar in a reply but did not emit a learn_from_admin_correction / remember_about_rep / record_admin_request tool block. Reply: "${cleaned.slice(0, 200)}". Source message: "${text.slice(0, 200)}". Recovered: ${recoverySuffix ? "yes" : ("reason" in analysis ? analysis.reason : "no")}. Rule: any claim-to-record requires a matching tool call in the SAME reply.`,
        confidence: 0.6,
      });
    } catch {/* best-effort */}
    console.warn(`[lark-agent/${transport}] CLAIMS_WITHOUT_TOOL`, {
      rep: rep.id,
      text: text.slice(0, 80),
      reply: cleaned.slice(0, 80),
      recovered: Boolean(recoverySuffix),
    });
  }

  let suffix = "";
  if (proposal) {
    const memorySuffix = await autoExecuteSafeProposal(session, proposal);
    if (memorySuffix) {
      suffix = memorySuffix;
    } else {
      // Destructive proposal that auto-execute-safe doesn't cover
      // (reassign_lead, reassign_leads_bulk, batch_send, propose_db_write,
      // etc.). We don't punt to the web — north star says everything is
      // doable in Lark. Solution: synthesize a record_admin_request
      // proposal carrying the destructive intent and execute it through
      // the same auto-exec path. That path (auto-execute-safe.ts:83 →
      // helper-read-tools.ts:runReadTool → admin-inbox-card.ts:sendAdminInboxCard)
      // already pushes a Lark interactive card to admin's DM with
      // ✓/❌ buttons. Admin clicking ✓ runs the existing
      // processAdminInboxCardAction handler (already in webhook
      // dispatcher). One real card-push path, used by everything.
      //
      // This mirrors the Intent page pattern: a user goal becomes an
      // action via a tool the harness already knows how to execute.
      const headline = describeProposalHeadline(proposal);
      const body = JSON.stringify(proposal, null, 2);
      const cardSuffix = await autoExecuteSafeProposal(session, {
        action: "record_admin_request",
        kind: "request",
        headline,
        body: `Leon proposed a destructive action in Lark. Click ✓ to approve, ❌ to reject. Raw proposal payload:\n\n\`\`\`json\n${body.slice(0, 1500)}\n\`\`\``,
        source_rep_id: session.repId,
        evidence: { proposal_action: proposal.action, original_proposal: proposal },
      });
      if (cardSuffix) {
        suffix = cardSuffix;
      } else {
        // record_admin_request itself failed — log loudly and surface
        // the failure to the user instead of pretending it worked.
        console.error("[lark-agent] failed to push admin card for proposal:", proposal.action);
        suffix = `\n\n— ⚠️ 我想给 admin 推一张 confirm 卡片, 但卡片推送失败了 (proposal: ${proposal.action}). 这是 bug, 不是设计 — admin 会从日志里看到.`;
      }
    }
  }
  const trimmed = (cleaned + suffix + recoverySuffix).trim();
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
  // Mirror the assistant reply to helper_messages so the web help-bot
  // sees this side of the conversation too. Without both sides mirrored
  // the bot only sees "rep said X" but not "I (Leon) said Y" — leading
  // to confused continuations when the rep switches surfaces.
  if (finalReply) {
    mirrorToHelperMessages(rep.id, "assistant", finalReply).catch(() => {});
  }

  // Log this rep question into rep_questions for the curriculum miner.
  // Outcome classification reflects what Leon actually did: solo-answered,
  // escalated, or hedged-without-action (deferred — a red flag).
  // Best-effort: failure here doesn't break the reply path.
  try {
    const { classifyOutcome, logRepQuestion } = await import("@/lib/rep-questions");
    const outcome = classifyOutcome({
      proposal,
      cleanedReply: cleaned,
      readToolsFired: agentResult.toolCallCount,
    });
    void logRepQuestion({
      repId: rep.id,
      rawText: text,
      outcome,
    });
  } catch (err) {
    console.warn(`[lark-agent/${transport}] logRepQuestion failed (non-blocking):`, err);
  }
  if (finalReply) {
    await sendMessage({
      receive_id: chatId,
      receive_id_type: "chat_id",
      text: finalReply,
    }).catch((e) => console.error(`[lark-agent/${transport}] reply sendMessage failed`, e));
  }

  return { ok: true };
}
