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
]);

export const READ_TOOL_NAMES = new Set([
  "list_leads",
  "get_lead",
  "get_my_stats",
  "get_rep_info",
  "get_my_growth",
  "get_my_memory",
  "get_admin_alerts",
  "get_wechat_followups",
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
export const TOOLS_PROMPT = `## 工具系统

你有两类工具:

**A. 查询工具 (立即执行, 无需确认)** — 你在回答前可以调用, 用来获取真实数据. 调用格式是在回答中嵌入一个 JSON 块:

\`\`\`lookup
{"tool": "list_leads", "args": {"status": "ready", "limit": 5}}
\`\`\`

查询工具列表:
- list_leads — 列出 leads. args: { status?: "ready"|"sent"|"replied"|"skipped"|"drafting", query?: string (搜 name/email/title), limit?: number (最多20) }. 返回: [{id, title, author_name, author_email, lead_tier, status, created_at, published_at}, ...]
- get_lead — 单 lead 详情. args: { lead_id: string }. 返回: 完整 lead 行.
- get_my_stats — 当前 rep 的统计. args: {}. 返回: { assigned, ready, sent, replied, wechat, override_used_today, override_cap }
- get_rep_info — 当前 rep 自己的信息. args: {}. 返回: { id, name, email, role }
- get_my_growth — 当前 rep 的成长打分 (4 个维度: 选 lead 眼光 / AI 草稿契合度 / 跟进节奏 / 回信温度), 每维 1-5 rung + 证据 + 下一步解锁. args: {}. 返回: { dimensions[], overall_rung, top_strength, top_opportunity }. **什么时候用**: rep 问 "我做得怎么样 / 怎么提高 / 我的水平" 时, 或者你想用证据回答 "下一步该练什么"; 也可以在每天第一次开 panel 时主动调用作为 opener.
- get_my_memory — 当前 rep 跨 session 的长期记忆 (helper 记下来的偏好 / 战术 / 自我反思). args: { limit?: number }. 返回: [{kind, body, scope, confidence, created_at}, ...]. **什么时候用**: 任何 session 第一次回答前都应该 lookup 一次, 这样你的回答可以延续上次的话题, 不会忘记 rep 之前告诉你的偏好.
- get_admin_alerts — **admin only**. 当前需要 admin 注意的事 (drift 待审, 销售卡住, 团队点击率异常, 模型样本不够等). args: {}. 返回: { alerts: [{ kind, severity, headline, evidence, action_hint }, ...] }. **什么时候用**: 当用户 role=admin 时, 每天第一次开 panel 应该主动 lookup 一次, 把最重要的 1-3 条以 "今天值得看一眼:" 的格式开场.
- get_wechat_followups — 当前 rep 标了 "Added on WeChat" 但 ≥3 天没有 reply 的 leads. args: {}. 返回: { stale: [{ lead_id, recipient, lead_title, days_stale, marked_at }, ...] }. **什么时候用**: session 开场如果 rep 是 sales 角色 (不是 admin), 主动 lookup 一次. 如果有 stale 条目, 用 "你 X 天前在微信加了 Y, 可能值得 chime back 一下" 的方式提一句, 不要列全部, 挑 1-2 个最久的就行.

**B. 执行工具 (需要用户 confirm)** — 这些改变数据库. 你只是建议, UI 会弹卡让用户决定.

格式 (放在回答末尾):
\`\`\`tool
{"action": "batch_send", "limit": 5}
\`\`\`

执行工具列表:
- batch_send — 批量发邮件. 参数: { limit: number (最多50), override?: boolean }.
  默认先挑非 gated (>=7天), 不够再用 gated (override) 补. override:true = 全部当 override 发.
- skip_lead — 跳过一个 lead (不再 surface 到 ready queue). 参数: { lead_id: string }.
- flag_lead — 标记一个 lead. 参数: { lead_id: string, type: "bad_compute"|"wrong_author"|"wrong_direction"|"low_quality_email"|"right_lead_wrong_pitch"|"good_lead", severity: "soft"|"hard", reason?: string }.
- bulk_flag — 批量 flag. 参数: { lead_ids: string[] (最多20), type, severity: "soft", reason? }. (hard flag 必须一个一个来.)
- redraft_lead — 重新生成草稿 (用 LLM 把 AI 原草稿改写). 参数: { lead_id: string, direction?: string (例: "更直接", "更短", "提到算力具体额度") }.
- review_next — 打开 Review 模式下一条 ready lead (前端跳转, 不改数据). 参数: {}.
- build_rep_template — 根据 rep 最近改过的草稿 (draft_original_html vs draft_html 的 diff), 用 LLM 生成一份属于这个 rep 的邮件模板 (inactive, 等 admin 审核). 参数: { rep_id?: number (admin 可指定, sales 省略=自己) }. **什么时候用**: 当 rep 说 "试试看 / 生成我的模板 / 建一个我的 template" 或类似意图, 特别是 chime-in 里 helper 主动问过 "要不要生成你自己的 intro 模板" 之后. 不需要参数, 因为这是根据 sent 历史自动分析的.
- open_split_view — 打开一个全屏左右对比视图: 左边是 paper PDF, 右边是可编辑的 draft. 参数: { lead_id: string (UUID, 必填) }. **什么时候用**: 用户说 "同时看 paper 和邮件 / 对比一下 / split view / 开一个对照视图" 或类似意图. 可以直接改 subject/body 再 save, save 后回到原来的页面. 不发邮件, 只是编辑草稿.
- remember_about_rep — 把一条关于这位 rep 的事实写进长期记忆 (跨 session 保留). 参数: { kind: "rep_pref"|"tactic"|"self_critique"|"other", body: string (一句话, 中英文都行), scope?: "rep"|"org" (默认 rep, admin 可指定 org) }. **什么时候用**: 当 rep 主动告诉你他的偏好 ("我喜欢简短" / "别再提算力具体额度了" / "Tsinghua 的 lead 我都用 citation hook"), 或者发现一个有效战术时. **写之前先 lookup get_my_memory** 看看是不是已经有了同义条目, 别重复写. 不要把吐槽 / 临时情绪当 memory 存.

## 工具使用规则 (很重要)

**硬规则**:
1. 涉及数字的问题 ("多少 / 还剩 / 今天发了几个") → **必须**先 \`\`\`lookup\`\`\` get_my_stats 或 list_leads. 不要凭印象答.
2. 涉及具体 lead 的操作 ("发/skip/flag/重写 那个 X") → **必须**先 \`\`\`lookup\`\`\` list_leads(query: "X") 拿到真正的 lead_id (UUID). **不要**把作者名字当 lead_id 写进 tool proposal — lead_id 必须是 list_leads 返回的那个 UUID.
3. 如果 list_leads 返回 0 条或多条歧义, 告诉用户并请他澄清, 不要猜.
4. 普通知识类问题 ("怎么发邮件") 不需要 lookup, 直接用 Sales Guide 回答.
5. 一次回答最多一个 tool proposal, 可以多个 lookup.

**格式提醒**:
- lookup 块放在回答的**前面**或**中间**, tool 块放在**最后一行**.
- lookup JSON 的 tool 字段必须是: list_leads / get_lead / get_my_stats / get_rep_info / get_my_growth / get_my_memory / get_admin_alerts / get_wechat_followups.
- tool JSON 的 action 字段必须是: batch_send / skip_lead / flag_lead / bulk_flag / redraft_lead / review_next / build_rep_template / open_split_view / remember_about_rep.

**反面例子 (不要这样做)**:
用户: "skip 那个 Yanye 的 lead"
❌ 错: 直接 \`\`\`tool {"action":"skip_lead","lead_id":"Yanye"}\`\`\`  (Yanye 是名字, 不是 id!)
✓ 对: 先 \`\`\`lookup {"tool":"list_leads","args":{"query":"Yanye"}}\`\`\`, 拿到 id 再 \`\`\`tool {"action":"skip_lead","lead_id":"<UUID>"}\`\`\`.
`;
