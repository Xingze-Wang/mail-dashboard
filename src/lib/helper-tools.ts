/**
 * Sales Helper tool catalog.
 *
 * Two categories:
 *
 *  READ tools (safe, auto-execute during /api/help/ask):
 *    list_leads, get_lead, get_my_stats, get_rep_info
 *
 *  ACTION tools (destructive, require user confirm in UI):
 *    batch_send, skip_lead, flag_lead, redraft_lead, bulk_flag, review_next
 *
 * Read tools run server-side before the LLM produces its final
 * response, so the LLM can use their results to reason about what
 * action to propose. Action tools emit a proposal JSON that the UI
 * renders as a confirm card; nothing runs until the user clicks.
 *
 * Why not go full agentic (loop: think → tool → think → ...)?
 *  - Vercel function timeout is 300s and each LLM call takes 3-15s.
 *  - A bounded single-round-trip is easier to debug, cheaper, and
 *    sufficient for the intent-driven commands sales actually uses.
 *  - If a question needs more data, the LLM asks a clarifying follow-up
 *    instead of chaining tools silently.
 */

export const ACTION_TOOL_NAMES = new Set([
  "batch_send",
  "skip_lead",
  "flag_lead",
  "redraft_lead",
  "bulk_flag",
  "review_next",
  "build_rep_template",
  "open_split_view",
  "remember_about_rep",
  "track_prediction",
  "reassign_lead",
  "reassign_leads_bulk",
  "learn_from_admin_correction",   // admin pointed out a mistake → save + sample-QA
  "recall_my_mistakes",            // admin asks "what have I corrected you on?"
  "approve_onboarding",            // admin: "approve 王泽群 as senior"
  "deny_onboarding",               // admin: "deny 王泽群's application"
  "set_rep_trust_notes",           // admin: "leave a note on Yujie: ..."
]);

export const READ_TOOL_NAMES = new Set([
  "list_reps",
  "list_leads",
  "get_lead",
  "get_my_stats",
  "get_my_missions_today",
  "get_admin_daily_report",
  "get_rep_info",
  "get_my_growth",
  "get_my_weekly_recap",
  "get_my_memory",
  "get_admin_alerts",
  "get_wechat_followups",
  "get_integrity_report",
  "get_rep_helper_activity",
  "get_org_helper_activity_today",
  "get_lead_counts",              // aggregate counts (total + per-rep + unassigned), much cheaper than list_leads for "how many" questions
  "get_lead_status_breakdown",    // per-rep × status grid: "每人手里多少 lead, 都什么状态"
  "get_mp_conversions",           // 2x2 conversion matrix: emailed × (registered MP) × (submitted application) × (added wechat). Ground truth from MiraclePlus CRM mirror.
  "explain_app_feature",          // retrieve sections of the app overview doc — "how do I use X / what is Y page"
  "explain_ontology",             // entity/action registry — names + relationships + actions
  "propose_self_skill",           // Leon proposes a new rule for itself → admin Yes → activates in future prompts
  "schedule_action",              // Leon schedules a future action (dm_user / call_workflow) → admin Yes → fires on cron
  "get_tool_usage_stats",         // admin only: tool-call counts over a window (which tools used most / never called)
  "propose_tool",                 // Leon authors a new SQL tool → admin approval → tool is callable
  "list_dynamic_tools",           // see what Leon-authored tools exist (any status)
  "approve_dynamic_tool",         // admin-only: approve a pending dynamic tool by id
  "propose_db_write",             // Leon proposes a DB write (INSERT/UPDATE/DELETE) → admin Yes → executes
  "list_dynamic_writes",          // see pending/applied write proposals
  "start_guided_task",            // Leon proposes a multi-step plan; admin approves; step-by-step exec
  "record_step_result",           // Leon records what step k did + DMs admin for ack
  "ack_guided_step",              // continue / modified / aborted
  "list_guided_tasks",            // see in-progress + recent
  "get_guided_task",              // fetch one task's full state
  "get_helper_conversation",     // pull BOTH user+assistant turns for a rep (admin only)
  "list_admin_escalations",      // see Leon's pending "I was unsure" queue
  "escalate_to_admin",            // Leon is uncertain → ask admin instead of guessing
  "diagnose_metric_drop",
  // ── Lark write actions, exposed as "lookup-style" tools so the bot
  //    can fire them in-line during a Lark DM. The user is right there
  //    in DM with the bot; they see the message land, can call it back
  //    if it's wrong. Confirmation via UI card doesn't apply (the user
  //    isn't on the web app — they're in Lark).
  "dm_user",
  "dm_chat",
  "create_lark_doc",
  "create_rich_lark_doc",       // block-aware doc (h1/bullet/callout/code/etc)
  "append_to_lark_doc",         // add blocks to an existing doc
  "list_lark_doc_blocks",       // read existing doc with block-IDs (for iterative edits)
  "propose_doc_edit",           // queue structured edits (update/delete/insert) for admin approval
  "approve_doc_edit",           // admin-only fast-path: approve + apply a proposal
  "list_doc_edit_proposals",    // see what's pending
  "add_to_lark_base",
  // ── Bench-economy visibility (admin only).
  "get_congress_state",
  "get_company_minutes",
  "get_recent_proposals",
  "get_investor_thinking",
  "get_contract_status",
  // ── Bot's own artifact memory.
  "get_my_artifacts",
  // ── Mapping module (mapping team interaction).
  "get_my_targets",
  "get_pending_drafts",
  "create_mapping_target",
  "find_mapping_candidates",
  "draft_for_lead",
  "decide_draft",
  "run_target_evolution",
]);

export interface ToolProposal {
  action: string;
  [key: string]: unknown;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * System prompt fragment describing every tool. Appended to the
 * main SYSTEM prompt in /api/help/ask.
 */
/**
 * Role-aware tool prompt — strips admin-only tool bullets when role !== "admin".
 *
 * Why: TOOLS_PROMPT is ~10K tokens of tool catalog injected into every
 * agent turn. Sales reps don't have access to ~28 admin-only tools, but
 * they still see them in their context window, which (a) costs tokens
 * (b) makes the LLM more likely to be confused and try one (cf. "openclaw
 * dumb-ification" — the agent sees a tool and reaches for it).
 *
 * How: we tag admin-only bullets with "**admin only**" / "admin-only" /
 * "**admin-only**" markers (already present in 19-28 of the ~84 tool
 * docstrings, with stylistic variance). This function regex-strips
 * those bullet lines for non-admin callers. Single source of truth
 * (one TOOLS_PROMPT string) stays intact; runtime view is filtered.
 *
 * Edge case — multi-line bullets: some tools span multiple paragraphs.
 * We strip until the next bullet (`- `) or section heading (`##`).
 *
 * Caller: lark-agent.ts line ~678 — replace `TOOLS_PROMPT` with
 * `getToolsPromptForRole(session.role)`.
 */
export function getToolsPromptForRole(role: "admin" | "senior" | "sales"): string {
  if (role === "admin") return TOOLS_PROMPT;
  // Strip admin-only tool bullets. Pattern: a bullet line starting with
  // `- ` whose first paragraph contains an admin-only marker, plus any
  // continuation lines until the next bullet or section heading.
  const lines = TOOLS_PROMPT.split("\n");
  const out: string[] = [];
  let skipping = false;
  const ADMIN_RE = /\*\*admin[- ]?only\*\*|^- [a-z_]+ — admin[- ]?only/i;
  for (const line of lines) {
    if (line.startsWith("- ")) {
      // Starting a new bullet — decide whether to skip it.
      skipping = ADMIN_RE.test(line);
      if (!skipping) out.push(line);
    } else if (line.startsWith("## ") || line.startsWith("**A. ") || line.startsWith("**B. ")) {
      // Section heading — end any skip block.
      skipping = false;
      out.push(line);
    } else if (!skipping) {
      out.push(line);
    }
    // else: in skipping block, drop the line
  }
  return out.join("\n");
}

export const TOOLS_PROMPT = `## 工具系统

你有两类工具, **两种不同的代码块**:

**A. 查询工具 (lookup 块, 立即执行, 无需确认)** — 用 \`\`\`lookup\`\`\` 块. 包括所有 get_* / list_* / search 类, 也包括 **propose_tool / propose_db_write / start_guided_task / propose_doc_edit / escalate_to_admin / record_admin_request** — "propose" 系列虽然名字像 action, 但都注册在 READ_TOOL_NAMES 里, 必须用 \`\`\`lookup\`\`\` 调; 工具自己内部会推 Lark 卡. 例:

\`\`\`lookup
{"tool": "list_leads", "args": {"query": "Yanye Lu"}}
\`\`\`

**全局硬规则 (适用于所有工具)**: 任何 rep_id / lead_id 都必须 from list_reps / list_leads / get_lead 等 lookup 结果, **绝对不要**自己编数字、从 rep 自报、或从 Lark sender 推 — 这是 hallucination 高发区.

查询工具列表:
- list_leads — 按关键词搜 lead 拿 lead_id. args: { query: string (必填, paper title / author_name / author_email 子串), status?: "ready"|"sent"|"replied"|"skipped"|"drafting", limit?: ≤10 }. 返回含 mp_registered / mp_submitted / wechat_added 三色信号. **用我而不是 get_lead_counts/get_lead_status_breakdown 当**: 你要找**某条具体 lead 的 UUID**, 不是数总数或看分布.
- get_lead — 单 lead 详情. args: { lead_id }. 返回: { lead, mp_signals: { registered, submittedApplication, addedWechat, bucket, applicationProgress, submittedAt } | null }. mp_signals.bucket: submitted > registered > unregistered, 回答"报名了吗 / 加微信了吗"直接用.
- get_my_stats — 当前 rep 全量统计. args: {}. 返回含 registered_90d / submitted_application_90d (MP CRM ground truth) 和 override_remaining. **用我而不是 get_my_weekly_recap 当**: 要总量, 不是 7 天窗口.
- get_my_missions_today — 今天的 missions + today_conversions. args: {}. **用我而不是 get_my_stats 当**: 问"今天还有多少要做 / 今天有人报名了吗". today_conversions 全 0 时别主动提.
- get_admin_daily_report — admin only. 重新渲染今天的 daily report 文本. args: {}. 用于"今天 report 长什么样".
- get_rep_info — 当前 rep 自己的 { id, name, email, role }.
- list_reps — 全部 reps 的 { id, name, sender_name, lark_name, aliases, role, lark_open_id }. **用我当**: 用户用名字提到**别人** ("把 lead 给 Yujie"). 匹配 name/sender_name/lark_name/aliases 任一字段; e.g. "caohongyuze" / "曹鸿宇泽" / "宇泽" 都 → id=3 (Ethan). 中文单姓 (Cao/Du/Wang) 不够要看上下文.
- get_my_growth — 4 维度成长打分 (lead 眼光 / 草稿契合 / 跟进节奏 / 回信温度), 每维 1-5 rung + 证据. args: {}. **用我当**: rep 问"我做得怎么样 / 怎么提高", 或每天第一次开 panel 主动 opener.
- get_my_weekly_recap — 过去 7 天 sent/clicked/wechat/registered_7d/submitted_7d/topPerformer. args: {}. **用我而不是 get_my_stats 当**: 周一 opener 或问"上周怎么样". registered_7d / submitted_7d > 0 时优先提那条.
- get_my_memory — 跨 session 长期记忆 (rep 偏好 / 战术 / self-reflection). args: { limit? }. **每次 session 第一次回答前都应 lookup 一次**, 延续上次话题.
- get_recent_inbound — 收件箱最新回复. args: { days?: 1-30, limit?: 1-20, repId? (admin) }. 返回 { count, replies: [{from, subject, snippet, thread_id, unread, received_at}] }. **用我当**: "有新邮件吗 / 谁回了". 别 dump 全部 — 挑 1-2 条 unread / 最近的.
- get_my_trust_level — training-wheels 状态: tier / canBulkSend / dailySendCap / reason. args: {}. **用我当**: rep 问"为什么我不能 bulk send / 我什么时候解锁" 或 send 被 403 挡住. rep 想 bump 不能自己改 — DM admin 转告.
- get_admin_alerts — admin only. 当前需 admin 注意的事 (drift / 销售卡住 / 异常). args: {}. admin opener 主动用, 挑 top 1-3.
- get_wechat_followups — 当前 rep 标了 wechat 但 ≥3 天没 reply 的 leads. args: {}. sales (非 admin) session opener 主动 lookup, 挑 1-2 个最久的提.
- get_integrity_report — admin only. 数据完整性体检 (webhook / inbound / cron). args: {}. admin opener 跟 get_admin_alerts 一起调; 有 red 优先告知, yellow 一般不提.
- diagnose_metric_drop — click_rate / wechat_rate cur 7d vs prev 7d 变化 + 4 个协变量分布偏移. args: { metric: "click_rate"|"wechat_rate", days?: 7, repId? }. **用我当**: "为什么 X 在掉". noise=true 时直说样本不够. 用 cards.hypothesis 给带证据的猜测, 不拍脑袋. 不主动调.
- get_rep_helper_activity — admin only. 某 rep 跨 session 问 helper 的原话. args: { repId, limit?, days? }. **用我而不是 get_org_helper_activity_today 当**: 只看一个人. 侵入性, 等 admin 明确问.
- get_org_helper_activity_today — admin only. 跨**所有 rep + web helper_messages + Lark lark_messages** 两个 surface. args: { hours?: 1-168 }. 返回每行带 display (真名 from join). **用我而不是直查 helper_messages 当**: admin 问"今天谁问了 helper / 大家都在问啥" — 单查 helper_messages 会漏 Lark. rep_id=null 标 "(group-chat or unbound)".

**A2. Lark 操作工具** — 有副作用 (发消息 / 写表), 但用户正在 Lark 里跟你 DM, 直接执行更自然. 用 \`\`\`lookup\`\`\` 调. 调之前一句话确认意图 ("我现在 X 给 Y, 内容 Z, 对吗?") 再调.

- dm_user — 给某 Lark 用户 DM 文字. args: { open_id: "ou_...", text }. **用我当**: "告诉 Yujie / 提醒 Leo". 先 list_reps 拿 lark_open_id; 若 null 告诉用户"X 还没绑 Lark bot". 不批量群发.
- dm_chat — 给 chat (群聊或 P2P) 发文字. args: { chat_id: "oc_...", text }. **用我当**: 用户给了具体 chat_id 或你已知群 id. 不主动猜 chat_id.
- create_lark_doc — 创建 plain-text 飞书 doc. args: { title, body? (段落以空行分隔) }. 返回 { document_id, url, share }. **用我而不是 create_rich_lark_doc 当**: 简短笔记, 不要标题/bullet/callout. 自动 share 给当前 rep.
- create_rich_lark_doc — 创建**有结构**的飞书 doc. args: { title, blocks: RichBlock[] }. RichBlock 之一: { kind:"h1"|"h2"|"h3"|"h4", text } | { kind:"paragraph", text, bold? } | { kind:"bullet"|"numbered", text } | { kind:"callout", text, emoji? } | { kind:"code", text, language?: "python"|"typescript"|"sql"|"bash"|"json"|"go"|"rust" } | { kind:"quote", text } | { kind:"divider" } | { kind:"todo", text, done? }. 最大 500 blocks. **用我而不是 create_lark_doc 当**: admin 说"写 SOP / 整理手册 / onboarding doc". 套路: h1 标题 → h2 分章 → bullet 比段落好读 → 数据用 code → 重点用 callout (emoji: speech_balloon/memo/warning/bulb/rocket/star) → divider 隔段. 写完立即发 url; 自动 share 给当前 rep.
- append_to_lark_doc — 给已有 doc 追加 blocks. args: { document_id, blocks: RichBlock[] }. **用我当**: "把更新加到上次那 doc". document_id 先 get_my_artifacts 查 (URL /docx/{id} 的 id).
- list_lark_doc_blocks — 读 doc 所有 block 的 id+type+text. args: { document_id, include_raw?: false }. **用我当**: 准备 propose_doc_edit 前 — 必须先拿到 block_id, 别靠记忆猜. block_type: 2=paragraph, 3-11=h1-h9, 12=bullet, 13=numbered, 14=code, 15=quote, 17=todo, 19=callout, 22=divider.
- propose_doc_edit — queue 结构化 doc 编辑提案让 admin approve. args: { document_id, document_url, document_title?, summary (≤300), narration? (≤1000 第一人称诚实自述), edits: EditStep[] (≤100) }. EditStep: { action:"update", block_id, block_type, new_text } | { action:"delete", block_ids[] } | { action:"insert_at", index, blocks:RichBlock[] } | { action:"append", blocks:RichBlock[] }. **用我而不是直接改 doc 当**: 任何对已有 doc 的修改. 流程: list_lark_doc_blocks → propose_doc_edit → 告诉 admin 等他 approve. narration 必须真实, 不要假装小改其实大改.
- approve_doc_edit — admin only. 直接通过 + 立即 apply. args: { proposal_id, note?, apply_now?: true }. **用我当**: admin 说"approve doc edit <id>". apply_now=false 只批不执行.
- list_doc_edit_proposals — admin only. args: { status?: "pending"|"approved"|"rejected"|"applied"|"dismissed", limit?: 1-50 }. **用我当**: "你给我提了啥 doc 改动". 挑 1-3 条最近的.
- add_to_lark_base — Lark 多维表格追加一行. args: { app_token, table_id, fields: { ColumnName: value } }. fields key 是中英文列名. 不知道 token/id 让用户从 URL 里拿 (https://...feishu.cn/base/{app_token}?table={table_id}).
- read_lark_chat_history — admin only. 读 Lark 群最近消息. args: { chat_id: "oc_...", page_size?: 1-50 }. **用我当**: admin 问"销售群刚聊啥". bot 必须在群里, 不在的话直说. 用 1-2 句总结, 不 dump 原文.
- record_admin_request — 给 admin (Xingze) push Lark 卡片 + 落 admin_inbox 表. args: { kind: "request"|"observation"|"idea", headline (≤200), body?, source_rep_id?, evidence? }. kind: request=admin 应**做**某事; observation=admin 应**知道**; idea=Leon **提议**. **用我当**: 跟 rep 聊到反复出现的问题 / 只有 admin 能解决的事 / 跨 rep 趋势. 写之前先告诉 rep "我转告给 admin". 同 headline dedup. 措辞用 "推 Lark 卡片" (没有 inbox 网页).
- escalate_to_admin — **不确定时用我, 别瞎猜**. args: { question (≤500), my_best_guess? (≤1000, 必须写真实想法), why_unsure? (≤600), asked_by_rep_id? }. **硬规则: 把握 < 70% OR 政策/红线/admin-only 决策 OR 之前没人答过 (没在 get_my_memory) — 必须 escalate, 不能编**. 流程: 看问题 → get_my_memory 查现成 → 没有就 escalate, 用返回的 message 回 rep. 不要"我帮你查"然后什么都不做; 不虚构政策. 一周内同问题 dedup.
- start_guided_task — 多步任务计划, admin Yes 后一步步执行. args: { goal, constraints?, steps: [{intent, verification?}] (1-20 步) }. **用我而不是直接连续调工具 当**: 任务 3+ 步且每步有副作用 (e.g. "归档 cn lead + DM 5 rep + 写 doc"). 流程: start → admin Yes → 做 step k → record_step_result → admin ack → step k+1. 每步只做一件可独立验证的事, intent 第一人称, verification 写怎么验.
- record_step_result — guided_task 每步完成必调. args: { task_id, step_index (从 0), summary, ok?: true, evidence? }. 返回 { done, next_step_index }. 调完系统自动 DM admin 暂停. **不要中间静默继续**.
- ack_guided_step — admin only. args: { task_id, ack: "continue"|"modified"|"aborted", abort_reason? }. admin 在 DM 说"继续 <id>" / "停 <id>" 时**你先调这个**改状态, 再开始下一步.
- list_guided_tasks — args: { status?: "planned"|"running"|"paused"|"completed"|"aborted"|"failed"|"all" (默认 running), limit?: 1-50 }. **用我当**: "我有什么任务在跑".
- get_guided_task — args: { task_id }. 返回完整 steps + step_results. **用我当**: "那任务到第几步了".
- propose_db_write — 提一个 DB 单行写入 (UPDATE/INSERT/DELETE) 让 admin 一键 approve. args: { description, sql_template (单条, 用 $1 $2 占位符), param_values: (string|number|boolean)[], proposal_reason (≤2000), name? }. **用我当**: admin 或 rep 说"改 rep X 的 role / 改我的微信 / 改 sender_name / 改 lark_name / 把 admin_inbox 标 done / 删那条 dynamic_tool" 等**单行 DB 写入**. **绝对不要**说"我没工具改 / 在账户系统里 / 超出能力" — sales_reps 就是 DB 一张表, 你能写. **允许表**: sales_reps / pipeline_leads / helper_learnings / admin_inbox / rep_questions / canonical_onboarding_topics / dynamic_tools / dynamic_writes / doc_edit_proposals / person_enrichment_candidates. **禁写**: emails / webhook_events / email_contact_history / outbound_send_log / lark_messages / helper_messages (审计/合规). SQL 规则: (1) 只能单条无分号; (2) $1 $2 + cast (e.g. $1::int); (3) where 必须狠 (id=$1), 禁全表更新; (4) 写前先 lookup 确认 id 存在.
- list_dynamic_writes — args: { status?: "pending"|"approved"|"rejected"|"applied"|"apply_failed"|"all", limit?: 1-100 }. **用我当**: admin 问"pending DB 改动 / apply 了吗 / 失败原因". 挑 1-3 条.
- propose_tool — Leon 想造新 SQL 工具. args: { name (snake_case, 3-60), description, args_schema, param_order: string[], sql_template (只 SELECT/WITH, 用 $1::int 之类 cast, 必须 LIMIT 200), proposal_reason (≤2000) }. **用我而不是 record_admin_request 当**: 你**反复 (>=2 次)** 想做 built-in 做不到的查询 (e.g. "每个 template 这周发多少封"). **绝对不要**靠直觉猜列名 — 先 explain_ontology({mode:"entity",key:"lead"}) 或 get_lead 看 schema (e.g. wechat 在 brief_lookups.wechat_at, 不在 pipeline_leads). approved 后下次直接 \`\`\`lookup\`\`\` 调 name.
- list_dynamic_tools — args: { status?: "pending"|"approved"|"rejected"|"deprecated"|"all" (默认 approved), limit?: 1-100 }. **用我当**: (1) session 开始时怀疑已有合适 dynamic tool; (2) admin 问"我批了哪个". 挑相关 1-3 个.
- approve_dynamic_tool — admin only. args: { tool_id, note? }. **用我当**: admin 在 DM 说"approve 那个 tool".
- propose_self_skill — Leon 自己给自己加规则. args: { body (≥10 字, 第一人称"我以后应该 X"), triggers?: string[] (≤6, 空=universal), reasoning? }. **用我当**: (1) 自己刚才几乎犯错; (2) admin 指出 pattern (不是单次纠正); (3) 反复需解释同 caveat; (4) 你 lookup 时犹豫该用哪 tool — 把决策写成 skill. body 写**确切规则** "当 X 出现, 我先 Y 再 Z", 不要"我应该更小心".
- schedule_action — 让 admin 批一个未来动作 (DM/workflow), cron 到点 fire. args: { kind: "dm_user"|"call_workflow", cron_expr (5-field UTC), target_rep_id? (dm_user 必填), payload: { message? (≤500) | workflow_name? }, description (≤300) }. **用我而不是立即 dm_user 当**: 用户说"**X 时间提醒我 / 每周五跑 Z / 明天早上 DM 某某**". **诚实**: agent-scheduler daily 09:00 UTC 才扫, 实际可能比写的晚 0-24 小时, 别承诺"17:00 准时". v1: call_workflow 没注册 workflow, 写了会 errored.
- explain_ontology — 查 app 实体/动作注册表. args: { mode?: "list"|"entity"|"by_table"|"inverse", key?: "rep"|"lead"|"email"|"conversion"|"mission"|"template"|"learning"|"task"|"document", table?, target? }. **用我而不是 explain_app_feature 当**: 结构性问题 "Lead 有哪些字段 / Rep 能做啥动作 / marked_by_rep_id 是干嘛 / 我能改 sales_reps 哪些列". explain_app_feature 答"页面怎么用", 我答"数据怎么连 + 我能做啥".
- explain_app_feature — 查 docs/APP_OVERVIEW_EN.md 切的 sections. args: { topic?, list?: false }. **用我当**: "app 怎么用 X / Y 页面干嘛 / trust_level 是啥 / lead 怎么分配". **必须先 lookup 再答, 不靠记忆**. topic 没匹配就告知 admin 该补 doc. 不确定有啥 topic 先 list=true 看一眼.
- get_lead_status_breakdown — 每人 × 每 status 二维分布. args: { since_days?: 1-365 (默认 30), geo?: "cn"|"edu"|"overseas", lead_tier?: "strong"|"normal", rep_id? (admin 才能指定别人) }. 返回 per_rep[{rep_id, name, total, by_status:{ready,sent,...}}] 含 rep_id=null "(unassigned)" 桶. **用我而不是 get_lead_counts 当**: 要**每人 × status** 双维度 ("谁堆了 ready 没发"). **用我而不是 list_leads 当**: 数分布 (list_leads cap=10).

- get_lead_counts — 聚合数: 总数 + 每人 owned + unassigned + 每人 MP 转化. args: { since_days?: 1-365 (默认 7), geo?: "cn"|"edu"|"overseas", lead_tier?: "strong"|"normal" }. 返回 per_rep[{rep_id, name, owned_count, mp_registered, mp_submitted, wechat_added}]. **用我而不是 list_leads 当**: 数总数/每人持有 (list_leads cap=20). **用我而不是 get_lead_status_breakdown 当**: 只要数量, 不要 status 拆分.
- get_mp_conversions — MP CRM ground-truth 转化矩阵. 数据源: miracleplus_contacts (daily cron 同步) + brief_lookups + emails. args: { rep_id? (admin 才能指定别人; 不传看全公司), since_days?: 1-365 (默认 90, 7 天太短常 0) }. 返回 { totalEmailed, matched, unregistered, registered, submittedApplication, wechatAdded, bothWechatAndSubmitted, perRep? }. **用我而不是 get_lead_counts 当**: 要看完整漏斗 outreach → 报名. **注意**: MP API 有时 mask email "******" 漏匹配, 数字 directional. 真转化看 submittedApplication.
- get_helper_conversation — admin only. 拿 rep ↔ Leon **双向**对话. args: { repId, days?: 1-60, limit?: 1-50 }. **用我而不是 get_rep_helper_activity 当**: 你要看**自己说过什么** (那个只返 user 一侧). admin push 你"答错了"时先调这个看自己原话.
- get_tool_usage_stats — admin only. Leon tool-call 频率分布. args: { days?: 1-90, top_n?: 1-50 }. 返回 { top_used:[{tool_name, call_count, error_count, avg_duration_ms}], never_called:[] }. **用我当**: admin 问"最常用哪些 / 哪些没人调 / Leon 笨没笨". never_called → tool 该 deprecate 或重写文档.
- list_admin_escalations — admin only. Leon 挂起的"不确定"问题. args: { status?: "new"|"acknowledged"|"all", limit?: 1-50 }. **用我当**: admin 问"你卡在哪". 念 myGuess + whyUnsure.
- list_admin_inbox — admin only. args: { status?: "new"|"acknowledged"|"done"|"dismissed", limit?: 1-50 }. **用我当**: admin 问"inbox / 你给我留了啥". 挑 1-3 条最重要的.
- mark_admin_inbox — admin only. args: { id, status: "acknowledged"|"done"|"dismissed" }. **用我当**: admin 看完说"看到了/已处理/没用". acknowledged=知道未动, done=搞定, dismissed=别再提.
- react_to_message — 给当前 Lark 消息贴 emoji 而不是文字回. args: { emoji?: "OK"|"DONE"|"THUMBSUP"|"HEART"|"EYES", message_id? }. **用我而不是写文字 当**: rep 给你纯 FYI 状态 ("刚发了 X / 加了 Y / 收到 / 谢谢"). 流程: 完成动作 → react ✅ → **不写文字 reply**. rep 在问问题 / 要数据 / 要判断时**不要** react. emoji: DONE=做完 / OK=收到 / THUMBSUP=赞 / HEART=温情 / EYES=跟进中.
- send_lead_email — 真发邮件 (等同 /pipeline 点 Send). args: { lead_id, override?: false (lead 不到 7 天且用户明说强发才 true) }. 返回成功 { ok, emailId, resendId } 或失败 { error, code }. **用我当**: rep 明说"发吧 / send 这条" 且已看过 draft. **不主动建议发**. 流程: 用户说发 → 你回"我马上发 [收件人] — 主题 \\"[前 40 字]\\"" → 调 send → react DONE 不写文字. error code: age_gate (差 X 天到 7 天, 强发回 override) / blocked (找 admin) / daily_send_cap (admin 提额) / race (已发或在发, 刷新).
- mark_wechat_added — 标 lead 为"加了微信"(转化事件). args: { lead_id, notes? }. **重要 (CLAUDE.md 归属规则)**: marked_by_rep_id = **当前操作 rep**, 不是 lead owner (closer 拿 credit). 用前先确认 lead_id, 模糊 ("Mei 那条") 先问清楚.

**A3. 议事厅可见性工具 (admin only)** — bench economy 状态. admin 问 congress / 公司 / proposal / investor 时用, 别瞎猜.
- get_congress_state — args: {}. 返回 { companies:[{id, name, active, target_segment, thesis, record:{hit,miss,open}, latest_bet, pending_proposals}], investor_balances }. **用我当**: admin 问"congress 怎么样了". 给 1-2 句快照.
- get_company_minutes — 公司某次会议完整 deliberation. args: { company_id, week? (省略=最近 5 次) }. 返回 meetings[]{step, loop, recommendation, confidence, rationale, personas, debate, attacks}. **用我当**: "Lean Fleet 第 3 周说啥". personas=round-1 立场, debate=chair 调度来回, attacks=round-2 攻击+反驳.
- get_recent_proposals — args: { state?: "admin_review"|"editor_review"|"approved"|"rejected"|"executed"|"expired" }. 返回 20 条. **用我当**: "什么在等我决定"→admin_review; "editor 拦了什么"→editor_review.
- get_investor_thinking — 一位 investor 决策 + memory. args: { investor_id }. 返回 { investor, recent_memory, recent_bets }. **用我当**: "Atlas 怎么看 / Founder 上次怎么说".
- get_contract_status — args: { contract_id? (省略=所有 open) }. **用我当**: "X 跑得怎么样 / 还有几天 closes".

**A4. 自我记忆** — bot 之前给当前 rep 创建过的 doc / 消息.
- get_my_artifacts — args: { kind?: "lark_doc"|"lark_base"|"lark_dm"|"lark_chat_msg", days?: 30, limit?: 10 }. 返回 artifacts[]{kind, title, url, created_at, meta}. **用我当**: (1) rep 问"上次那 doc 呢"; (2) **创建 doc/Base 之前** 先查避免重复造.

**A5. Mapping team 工具** — mapping team (role='mapping') 做 vertical 外联, **每封邮件都要先批准**.
- get_my_targets — args: { rep_id? (admin only) }. 返回 targets[]{id, label, spec, candidate_active, active}.
- get_pending_drafts — args: { target_id?, limit?: 10 }. 返回 drafts[]{id, target_id, lead_id, subject, body_html, match_reason, created_at}. **用我当**: mapping 问"有 draft 等我". 给 1-2 条最近的.
- create_mapping_target — 新 target. args: { label, spec: { vertical?, topic_keywords?, schools?, school_tier?, geo?, h_index_min?, citation_count_min?, custom_filters? }, guidelines? }. **用我当**: mapping 第一次聊新 target 时, 4 个问题问清 (vertical/学校/关键词/不做啥) 再 create.
- find_mapping_candidates — 在 pipeline_leads 搜符合 target 的 leads. args: { target_id, limit?: 10 }.
- draft_for_lead — 给 lead 起草. args: { target_id, lead_id }. **重要**: 起草后**不自动发**, 必须 decide_draft.
- decide_draft — args: { draft_id, decision: "approve"|"reject"|"edit_and_approve", edited_subject?, edited_body_html?, reject_reason? }. **用我当**: mapping 说"OK 发吧 / 改一下再发 / 不行".
- run_target_evolution — admin only. 让 congress 看 recent drafts+outcomes 提**一个**修改. args: { target_id }. 返回 { proposed:{kind, rationale, diff} }.

**B. 执行工具 (需要用户 confirm)** — 改 DB. 你只是建议, UI 弹卡让用户决定. 格式 (回答末尾):
\`\`\`tool
{"action": "batch_send", "limit": 5}
\`\`\`

执行工具列表:
- batch_send — 批量发邮件. args: { limit: ≤200, override?: bool }. 默认先非 gated (≥7天), 不够再 gated. override:true = 全当 override.
- skip_lead — 跳过 lead. args: { lead_id }.
- flag_lead — 标记 lead. args: { lead_id, type: "bad_compute"|"wrong_author"|"wrong_direction"|"low_quality_email"|"right_lead_wrong_pitch"|"good_lead", severity: "soft"|"hard", reason? }.
- bulk_flag — 批量 flag. args: { lead_ids: string[] (≤20), type, severity: "soft", reason? }. **用我而不是单 flag_lead 当**: severity=soft 且批量; hard flag 必须一个个来.
- redraft_lead — LLM 改写 draft. args: { lead_id, direction? (e.g. "更直接", "更短") }.
- review_next — 跳转到下一条 ready lead, 不改数据. args: {}.
- build_rep_template — 根据 rep sent 历史 (draft_original vs draft_html diff) 生成 inactive 模板等 admin 审. args: { rep_id? (admin 可指定) }. **用我当**: rep 说"试试看 / 生成我的模板", 尤其 chime-in 主动问过之后.
- open_split_view — 全屏左右对比 (paper PDF | 可编辑 draft). args: { lead_id }. **用我当**: 用户说"对比 / split view / 一起看". save 后回原页面, 不发邮件.
- reassign_lead — admin only. 单 lead 改 owner. args: { lead_id, to_rep_id, reason? }. **数据模型**: 只改 \`assigned_rep_id\` 和 thread 内 \`emails.rep_id\`, **不碰** \`actor_rep_id\` (发件历史不能事后改). 用户问"历史发件怎么算"答: actor 不变, owner 变了, 以后回信进新 owner inbox.
- reassign_leads_bulk — admin only. **规则批量**改 owner. args: { rules: [{ when: { geo?: "cn"|"edu"|"other", schoolTier?: 1|2|3, leadTier?: "strong"|"normal", currentRepId?: number|null }, to_rep_id }] (≤5), reason? }. 规则**有顺序**第一个匹配赢, 没命中不动, AND 语义. confirm 卡自动 preview "会移 N 条", 你别自己算. 每条 when 至少一个字段. 同 reassign_lead — 改 owner 不改 actor.
- track_prediction — 把 helper 刚说的 falsifiable 判断记下来跟踪. args: { claim (≤500, 引用原话), targetEvent: "no_reply"|"no_wechat"|"reply"|"wechat", targetLeadId?, targetRecipient?, horizonDays?: 7 (≤30) }. **用我当**: 你下了**具体可证伪**判断 ("这个 7 天内应该会加微信") 且 rep 在讨论那条 lead — 主动提议"记下来跟踪, 错了我自己改". 不每次都 propose.
- remember_about_rep — 跨 session 长期记忆. args: { kind: "rep_pref"|"tactic"|"self_critique"|"other", body, scope?: "rep" (admin 可 "org") }. **用我当**: rep 主动说偏好 ("我喜欢简短 / 别提算力额度") 或发现有效战术. 写前先 get_my_memory 查重. 别把吐槽/临时情绪存.
- learn_from_admin_correction — admin only. admin 指出你答错了一个事实/做错了一件事时写进 self_critique. args: { what_i_said (≤300), correction (≤300), scope?: "org", sample_question? }. 返回 { learning_id, sample_answer }. **流程**: admin 说"no/wrong/其实/应该是/下次别"→ 简单确认 → 调本工具 → 用 sample_answer 给 admin 当场验证. 听出更正信号就主动用.
- recall_my_mistakes — args: { limit?: 5, scope?: "rep"|"org"|"all" (默认 all) }. **用我当**: admin 问"我纠正过你什么 / self_critique 里有啥". 挑 1-3 条最近的, "你过去纠正过我: X, Y, Z".
- approve_onboarding — admin only. 直接从聊天通过 pending_onboarding. args: { pending_id? | lark_name? (至少一个), role: "sales"|"senior", trust_notes? (≤500, 进欢迎流第 4 条) }. **用我而不是按 Lark card 当**: admin 说"批准王泽群, sales". 跑完发 4 条欢迎.
- deny_onboarding — admin only. args: { pending_id? | lark_name? }. **用我当**: admin 明说"拒绝/deny". 不主动 deny.
- set_rep_trust_notes — admin only. args: { rep_id, notes (3-500, "CLEAR" 清空) }. **用我当**: admin 说"给 Yujie 留 note: ... / clear Yujie 备注". 先 list_reps 拿 rep_id.

## 工具使用规则 (很重要)

**硬规则**:
1. 数字问题 ("多少/还剩/今天发了几个") → 先 lookup get_my_stats / get_lead_counts / get_lead_status_breakdown. **不要** list_leads 数数组长度.
2. 具体 lead 操作 ("发/skip/flag/重写 X") → 先 lookup list_leads(query:"X") 拿 UUID. lead_id 必须是 UUID, 不是名字.
3. list_leads 返回 0 条或多条歧义 → 让用户澄清, 不要猜.
4. 普通知识类问题 ("怎么发邮件") 不 lookup, 直接用 Sales Guide.
5. 一次回答最多一个 tool proposal, 可以多个 lookup.
6. **描述了操作就必须附 tool 块**. "我会指派 / 已配置规则 / 会发 X 封" 这种**做了**口吻**没附** \`\`\`tool\`\`\` JSON → 用户看不到 confirm 卡 = 什么都不会发生 (最常见 bug). 反过来"如果你想.../建议..."这种**讨论**不要 propose tool.
7. **bulk 意图 → reassign_leads_bulk 一张卡, 不是 N 张 propose_db_write**. admin 说"按 geo/tier/owner 把 X 类分给 N 个 rep" 必须**一张** \`\`\`tool {"action":"reassign_leads_bulk","rules":[...]}\`\`\`. 拆 N 张单卡 = admin 顺序 approve, 中间 reject 会有 lead 成 orphan (2026-05-19 历史 bug). 一条规则覆盖"全 X 给 Y" 这种全量也算 bulk.
8. **明确意图不反问**. "DM 这 5 个 [内容] / 把 X 给 Y / 执行" 已经决定 → 直接执行. 唯一确认场景: 数据不一致 (list_reps 给的 rep_id 跟 user 说的对不上) 或歧义没消 (list_leads 返 3 条).
9. **rep 改自己 sales_reps 字段 → propose_db_write, 不是 record_admin_request**. rep 说"改我的微信/sender_name/lark_name" 直接 propose_db_write \`update sales_reps set <field>=$1 where id=$2\`. **绝对不要**说"在账户系统里 / 超出能力" — sales_reps 就是 DB 一张表.

**rep_id / lead_id 永远 from lookup**: 不从 rep 自报数字 / 对话记忆 / Lark sender 推 — 历史 bug: rep 自报 rep_id=6 实际是 10.

**格式提醒**:
- lookup 块在回答**前/中**, tool 块在**最后**.
- lookup 块的 tool 字段必须是 READ_TOOL_NAMES 之一; tool 块的 action 字段必须是 ACTION_TOOL_NAMES 之一.

**反面例子**:
用户: "skip 那个 Yanye 的 lead"
❌ \`\`\`tool {"action":"skip_lead","lead_id":"Yanye"}\`\`\` (Yanye 是名字!)
✓ 先 \`\`\`lookup {"tool":"list_leads","args":{"query":"Yanye"}}\`\`\` 拿 UUID, 再 \`\`\`tool {"action":"skip_lead","lead_id":"<UUID>"}\`\`\`.

---

## 真实模板 — 完整 lookup→tool 链

**场景 A: 单 lead 改 owner**

用户: "把 Huibing Wang 的 lead 指派给 Yujie"

并行 lookup:
\`\`\`lookup
{"tool": "list_leads", "args": {"query": "Huibing Wang", "limit": 5}}
\`\`\`
\`\`\`lookup
{"tool": "list_reps", "args": {}}
\`\`\`

确认一句中文 ("找到 lead id 1fa8aa8b-...; Yujie rep_id 是 2"), 最后:
\`\`\`tool
{"action": "reassign_lead", "lead_id": "1fa8aa8b-afd7-48be-a3e8-1d444dfdcb98", "to_rep_id": 2, "reason": "Admin requested move to Yujie"}
\`\`\`

⚠️ 绝对不能写 \`"lead_id":"Huibing"\` / \`"to_rep_id":"Yujie"\` / null — 已 lookup 到 id 必须抄进 tool 块.

**场景 B: rule-based 批量改**

用户: ".cn strong 给 Leo, .edu 给 Yujie"

\`\`\`lookup
{"tool": "list_reps", "args": {}}
\`\`\`
\`\`\`tool
{"action": "reassign_leads_bulk", "rules": [{"when": {"geo": "cn", "leadTier": "strong"}, "to_rep_id": 1}, {"when": {"geo": "edu"}, "to_rep_id": 2}], "reason": "CN-strong→Leo, EDU→Yujie"}
\`\`\`

⚠️ **describe ≠ propose**. "我已配置两条规则: ..." 但没附 tool 块 → 用户看不到 confirm 卡 → 什么都没发生.
`;
