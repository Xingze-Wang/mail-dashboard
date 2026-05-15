// app-overview-corpus — sections from docs/APP_OVERVIEW_EN.md loaded
// into the helper bot so it can answer "how do I use X" / "what does
// this page show" / "where do I find Y" questions.
//
// Why a structured corpus instead of dumping the whole doc into the
// system prompt: 789-line doc = ~30KB; that's too much per turn.
// Instead we split into named sections and the bot retrieves only
// the relevant slice via the explain_app_feature tool.
//
// Keep in sync with /docs/APP_OVERVIEW_EN.md when that doc changes.
// (Future: a build step could parse the markdown directly. For now
// this is hand-curated to give the bot the right level of detail.)

export interface AppSection {
  key: string;
  title: string;
  body: string;
  // Keywords that should match this section. Includes Chinese.
  triggers: string[];
}

export const APP_OVERVIEW_SECTIONS: AppSection[] = [
  {
    key: "what_is_this",
    title: "What Qiji Pipeline is",
    triggers: ["what is this app", "what does this do", "qiji pipeline", "这个 app", "这是什么", "干什么的"],
    body: `Qiji Pipeline 是一个自动化系统, 给中国 AI 研究者发 GPU 算力 grant 的 outreach.

每天的循环:
1. 早 6 AM 跑 cron — 扫 arXiv 新论文 (cs.LG, cs.AI, cs.CV, cs.CL, cs.RO, stat.ML), 拉作者信息
2. 用 Semantic Scholar 拿作者的 h-index / citation_count
3. 按学校 tier + citation 标记 lead 为 "strong" 或 "normal"
4. 按规则分配给 sales rep (Leo / Yujie / Ethan)
5. 生成个性化邮件 draft (写好但不发)
6. Rep 在 /pipeline 看, 审一遍, 点 Send
7. Rep 在 /brief 标记 WeChat 转化 (谁加了客户微信)

总目标: 从 arXiv 论文到发出邮件 < 24 小时, 高比例转化到 WeChat.`,
  },
  {
    key: "page_pipeline",
    title: "The /pipeline page",
    triggers: ["pipeline page", "/pipeline", "review leads", "send emails", "审核", "发邮件", "处理 lead"],
    body: `**/pipeline** 是 rep 每天主要工作的地方.

布局:
- 顶部 stat strip — Total leads / This week / Ready to send / Sent 7d / Reply rate
- 3 个 tabs: Leads / Channels / Sales
- Leads tab 里有 3 个 mode chip: Browse / Review / Bulk

**Browse mode** (默认): 滚动 lead 卡片, 每条上有快捷按钮 Skip / Review / Preview / Send. 一键 Send.

**Review mode**: 一次看一条 lead, 左边 paper 右边 draft. 按 J/K 切换 lead, Cmd+Enter 发送. 适合专注审核.

**Bulk mode**: 多选若干 lead, 一次性发. 适合处理积压.

**Filters**:
- 状态 chip: ready / sent / replied / skipped / etc.
- Rep pill: 切换看谁的 lead
- Sort: 按时间 / tier / 投递时间

**Send 规则**:
- 论文 ≥ 7 天才能正常 Send (cooldown)
- < 7 天的可以点 "Send (Xd · override)" 强发, 走 override 路径
- 每天 send cap 由 trust_level 决定 (sales 通常 50/天, admin 不限)`,
  },
  {
    key: "page_missions",
    title: "The /missions page",
    triggers: ["missions page", "/missions", "today's missions", "今日任务", "team overview", "team grid"],
    body: `**/missions** 是 rep 看今日任务 + admin 看团队状态的地方.

**Rep 视角**:
- 顶部 banner: "Today" — 今天的 narrative brief (LLM 生成, 一句话目标 + 推理 + 战术 bullets)
- 下面 quarterly goals chip 条
- Team focus banner (本周方向)
- "My missions" checklist — 今天的 send/reply/wechat 目标 + 进度条

**Admin 视角**:
- 顶部 "Team today" 状态条 — "N stuck · M need a look · click any card to drill in"
- 团队 grid: 每个 rep 一张 card, 显示 health 灯 (绿/黄/红) + 今天的 goal + 3 个 KPI (Sends 7d / Replies / WeChat) + ready queue + 最后活动时间
- 点 card → 弹出 drill modal — 完整 brief / 今日 missions / 最近 15 条 send / 最近 inbound replies / 最近 wechat / 升级到 Leon 的问题 / Leon 对这个 rep 的 learnings`,
  },
  {
    key: "page_brief",
    title: "The /brief page (WeChat conversion marking)",
    triggers: ["brief page", "/brief", "wechat", "微信", "转化", "mark wechat"],
    body: `**/brief** 是标记 WeChat 转化的地方.

流程:
1. Rep 在 LinkedIn / WeChat 联系上一个 researcher
2. Rep 来 /brief 输入 query (作者名 / arxiv id / 邮箱)
3. 系统找到 lead, rep 点 "+ Added on WeChat"
4. 写在 brief_lookups 表里, **marked_by_rep_id = 当前 rep** (不是 lead owner)

**重要 (attribution 规则)**: 谁标的, 谁拿 credit. 比如 Yujie 名下的 lead 被 Leo 加了微信, marked_by_rep_id = Leo. 这是 "closer 拿 credit" 设计, 不要试图用 owner 替代.`,
  },
  {
    key: "page_emails",
    title: "The /emails page (sent email log + inbound replies)",
    triggers: ["emails page", "/emails", "sent log", "inbox replies", "邮件日志", "回复"],
    body: `**/emails** 显示已发出邮件 + 收到的回复.

左边: 邮件列表 (按时间倒序). 状态 chip: sent / delivered / opened / clicked / replied / bounced.
右边: 当选中一封邮件时, 显示完整内容 + 回复 thread.

如果收到 inbound reply, 邮件会自动标记 replied, 在 /pipeline 那边 lead 也会显示 reply 状态.

**注意**: emails.status 是 "latest event wins" — 如果 admin 想要审计级别的精确事件流, 应该查 webhook_events 表 (append-only).`,
  },
  {
    key: "page_admin_inbox",
    title: "The /admin/inbox page (Leon's notes for admin)",
    triggers: ["admin inbox", "/admin/inbox", "leon notes", "admin notifications", "管理员收件箱"],
    body: `**/admin/inbox** 是 Leon (bot) 给 admin 留的 ping 集合. Leon 注意到的东西在这里堆.

每条有:
- kind: request (admin 要做点啥) / observation (admin 该知道) / idea (Leon 建议)
- 来源 chip: 🤔 Leon 不确定 (escalation) / 👀 Leon 注意到的 / 📊 跨 rep 模式 / 🧰 Leon 想造工具 / 🏛 议事厅 / 🙋 Rep 请求 / ✍️ Admin 自己记的
- Yes / No 按钮 (Yes 自动分类成 skill/memory, No 进 awaiting_reason — 你在 DM 里说 "因为..." 就记下原因)

**Quick clean 工具栏** (有 pending 时显示):
- "Hypothesis tests" — 一键清掉 🧪 hypothesis 测试 batch
- "SMOKE rows" — 清掉 smoke test 遗留
- "Older than 14d" — 清掉 14 天没动过的
- "Select all visible" — 全选, 用复选框 + Dismiss N 按钮批量删

每天 06:30 UTC 的 inbox-auto-archive cron 也会自动清 SMOKE/14天stale 行.`,
  },
  {
    key: "page_admin_intent",
    title: "The /admin/intent page (intent → guided task)",
    triggers: ["intent page", "/admin/intent", "guided task", "multi-step", "admin intent", "提需求"],
    body: `**/admin/intent** 是 admin 跟 bot 协作做多步任务的地方.

流程:
1. Admin 在 textarea 写目标 (e.g. "把所有 cn 的 strong lead 重新归档给 Yujie, 然后给 Yujie 发个 summary")
2. 点 "Plan it" → LLM 拆成 1-7 步, 每步标 risk_level=auto (自动跑) 或 review (要 admin ✓)
3. Admin 在 web 上 inline 编辑 plan 步骤, 可以加约束
4. 点 "开始执行" → Lark 推 Yes/No 卡确认
5. 卡上 Yes → 任务开始. 每完成一步 paused 等 admin ack (如果是 review step) 或 auto-continue (如果是 auto step)
6. Web 页面实时显示进度 (2.5s poll)

Lark DM 平价: admin 可以在 Lark 里说 "继续 <id>" / "停 <id>" / "现在 plan 怎么样了", 跟 web 互通.`,
  },
  {
    key: "page_analysis",
    title: "The /analysis page (insights)",
    triggers: ["analysis page", "/analysis", "insights", "数据洞察", "cards"],
    body: `**/analysis** 是 LLM-curated 数据分析页. 每天 06:00 UTC 的 cron 重新评估每个 dimension cut, 如果 LLM 觉得 "材料级别变了" 就 publish 新 snapshot, 否则保持昨天的.

页面显示:
- Headline metric (本周 WeChat conversions vs 上周)
- Sparkline (过去 8 周)
- 2-3 张 LLM 写的 cards, 每张是一个判断 + 证据 + 下一步
- Geo split (CN vs 海外 CTR / 转化率)
- Segment splits (lead_tier, school_tier, h_index 段, direction)

**重要**: 数据是**每天早上 prewarm** 的, 不是实时. 你看到的数字是早上 06:15 UTC LLM 决定 publish 的. Banner 上会显示 "realigned because X" 当 LLM 觉得今天和昨天有 material change.`,
  },
  {
    key: "helper_bot_leon",
    title: "The helper bot (Leon)",
    triggers: ["bot", "leon", "helper", "ai assistant", "lark bot", "助手", "机器人"],
    body: `**Leon** 是 sales-facing AI helper. 两个 surface:
- Web: dashboard 右下角 ✨ icon 弹出 panel
- Lark: 直接 @bot 或 DM (账号 calistamind)

Leon 能做的:
1. **Lookup 数据** (lookup tools) — list_leads, get_my_stats, get_admin_daily_report, get_lead_counts, list_reps, diagnose_metric_drop, etc.
2. **Action proposals** (action tools) — batch_send, redraft_lead, reassign_lead 等; web 上需要 ✓ 确认, Lark 上一般直接执行 (admin 看到 = 实时反馈)
3. **Propose new SQL tools** (propose_tool) — Leon 写一个 SELECT, admin Yes → 工具立刻可用
4. **Propose DB writes** (propose_db_write) — Leon 写 INSERT/UPDATE/DELETE, admin Yes → 执行. 白名单 10 张表, 11 张审计表禁止写
5. **Doc edits** — 飞书 doc 创建 / 编辑 (block-aware), 通过 propose-approve loop
6. **Guided tasks** — 多步任务, 每步 risk-level 决定要不要等 admin ack
7. **Escalation** — 不确定就 escalate_to_admin, my_best_guess 必填

**记忆系统**: helper_learnings 表里存 skills (永久激活的程序) + memories (FTS-relevance 召回的事实). 每次 query 加载 universal skills + trigger-matched skills + top FTS memories.`,
  },
  {
    key: "lead_classification",
    title: "Lead classification: strong vs normal",
    triggers: ["strong lead", "normal lead", "lead tier", "classify", "tier 分类"],
    body: `**Strong vs Normal** 分类规则 (在 src/lib/assignment.ts):

一个 lead 是 **Strong** 如果:
- citation_count > 2000, OR
- school_tier ∈ {1, 2} (Tier 1 或 Tier 2 学校)

否则: **Normal**.

存在 pipeline_leads.lead_tier 列里.

**School tiers** (src/lib/scanner-config.ts, ~40 学校):
- Tier 1: MIT, Stanford, Berkeley, CMU, Harvard, Tsinghua, PKU, ...
- Tier 2: Georgia Tech, UChicago, HKUST, SJTU, Zhejiang, ...
- Tier 3: 其他验证过的 (CAS, BUAA, ...)
- 没匹配上: tier = null`,
  },
  {
    key: "lead_assignment",
    title: "Lead assignment to reps",
    triggers: ["assign lead", "rep assignment", "routing", "分配", "归属", "owner"],
    body: `**Assignment 规则** (src/lib/assignment.ts, assignRep()):

1. **Strong tier** → **Leo** (rep_id=1) — senior rep 处理高 impact 研究者
2. **Normal + overseas** (email 不是 .cn) → **Ethan** (rep_id=3)
3. **Normal + .cn 国内** → **Yujie** (rep_id=2)

每个 rep 有每日 send cap (sales 默认 50, senior 默认 100, admin 不限).

**重要 attribution 规则**:
- pipeline_leads.assigned_rep_id = OWNER (谁拿到 lead)
- emails.actor_rep_id = WHO SENT (审计 — 谁按了 Send)
- brief_lookups.marked_by_rep_id = WHO RECORDED WECHAT (closer 拿 credit)

转化归属用 marked_by_rep_id, 不要用 assigned_rep_id. 跟 closer 走, 不跟 lead owner 走.`,
  },
  {
    key: "trust_level",
    title: "Trust levels & send caps",
    triggers: ["trust level", "send cap", "bulk send", "daily limit", "训练轮", "信任等级"],
    body: `Rep 有 5 个 trust_level (在 sales_reps.trust_level):
- **novice** (0): 不能 bulk send. 日 send cap 10, 每天最多看 30 个 lead
- **training** (1): 不能 bulk send. 日 cap 30, lead cap 80
- **intermediate** (2): bulk batch 最大 10. 日 cap 50, lead cap 150
- **mature** (3): bulk batch 50. 日 cap 100
- **admin** (∞): 无 cap, 任意 bulk

Trust 自动升级 (在 src/lib/onboarding.ts):
- 累计 send > 50 → bump to training
- 累计 send > 200 → bump to intermediate
- 累计 send > 500 + 转化率 > avg → bump to mature

Admin 可以手动 bump 通过 dm Leon "bump Yujie trust_level" → Leon propose_db_write → admin Yes → 立即生效.`,
  },
  {
    key: "drafts_templates",
    title: "Draft email generation & template system",
    triggers: ["drafts", "templates", "email template", "draft generation", "模板", "邮件草稿"],
    body: `**Draft 生成时机**: 不是 import 时, 而是 **send 时** (lazy). 这样模板/template 改了立即生效, 不用 re-render.

**模板层级** (src/lib/template-assembler.ts):
1. **Per-rep template** (email_templates with sender_email match) — rep 自己的版本
2. **Global default** — fallback 模板
3. **Overrides** — email_template_overrides 表, segment-conditional (geo + school_tier)
   - e.g. "如果 geo=cn AND school_tier=1, 把 opening 替换成 X"

**Render 在 send 时**:
- POST /api/pipeline/send 调 assembleDraft(rep_id, lead_id)
- load 模板 + apply overrides + substitute {{paper_title}} {{first_name}} 等占位符
- 生成最终 HTML
- 同时记下 emails.template_id (用于 /api/templates/performance 分析)

**Lazy draft 给 rep 预览**: Python scanner 写一个 baseline draft 到 pipeline_leads.draft_html, rep 在 /pipeline 看到就有内容, 不用等 send 时 re-render.`,
  },
  {
    key: "cron_schedule",
    title: "Daily cron schedule",
    triggers: ["cron", "schedule", "daily", "nightly", "what runs when", "什么时候跑"],
    body: `每日 6 AM UTC 跑 /api/cron, 顺序执行:
1. Resend webhook sync — 拉昨天的 send/delivery/click 事件
2. arXiv scan — 找新论文, 跑 enrichment, 分类, 分配 rep
3. Drift mining — 从昨天 sales 编辑过的邮件里抽 prompt pattern
4. Retrain signals — scorer 模型重新校准

外加每个 fan-out 子 cron:
- 06:00 insights-realign — 每个 dimension cut LLM 决定要不要 publish 新 snapshot
- 06:15 insights-prewarm — pre-compute /analysis 页面给每个 rep
- 06:30 daily-rep-brief — 每个 rep 的 "Today" narrative brief
- 06:30 inbox-auto-archive — 清掉 14d-stale + smoke rows
- 07:00 (Thursday only) congress-topic-propose — 提案下周一 congress 议题
- 23:00 missions-heuristic-seed — 给明天种 missions
- 01:00 (Mon-Fri) missions-allocate-leads — 把新 lead 分配给 rep

**Lark worker** 是个独立 long-running process (npx tsx scripts/lark-bot-worker.ts), 不在 cron 里. 它负责接收 Lark DM events 走 long-connection, 比 HTTP webhook 稳定.`,
  },
  {
    key: "congress_system",
    title: "The Congress system (strategic deliberation)",
    triggers: ["congress", "tactical proposal", "议事厅", "weekly deliberation", "战略"],
    body: `**Congress** 是周一早上跑的多 persona LLM debate 系统 (Tactical Congress).

输入: 过去一周的数据 (转化率, 模板表现, rep edits, drift patterns, admin_inbox idea/observation).
LLM 用多个 persona (Conservative / Aggressive / Data-Analyst / Adversary) debate, 提 tactical_proposals.
Admin 在 /congress 页面看 proposals, 决定 approve/reject.

**Mid-week proposer** (Thursday 07:00 UTC) — 看过去 7 天数据 + admin_inbox + 升级问题, 提 1-3 个"周一该 debate"的话题. 每个进 admin_inbox 卡, Yes/No, Yes 的话周一 congress 会自动作为 proposal 进入 debate.

**Bench economy** (/bench, /scorer, /drift, /editor) — 一组配套页面, 每个看 congress 系统的不同切片. 目前 4 个 admin 页面, 可能未来合并成一个 "Lab" tabbed view.`,
  },
];

/** Look up sections matching a query. Naive scoring: count trigger-keyword hits + title hits. */
export function findRelevantSections(query: string, limit = 2): AppSection[] {
  const q = query.toLowerCase();
  const scored = APP_OVERVIEW_SECTIONS.map((s) => {
    let score = 0;
    for (const t of s.triggers) {
      if (q.includes(t.toLowerCase())) score += 2;
    }
    // Title overlap (lower weight)
    const titleWords = s.title.toLowerCase().split(/\s+/);
    for (const w of titleWords) {
      if (w.length >= 3 && q.includes(w)) score += 1;
    }
    return { section: s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 0).slice(0, limit).map((x) => x.section);
}

/** List of all section keys + titles + first-line summary. Used when the bot wants to know what's available. */
export function listSectionTopics(): Array<{ key: string; title: string; triggers: string[] }> {
  return APP_OVERVIEW_SECTIONS.map((s) => ({
    key: s.key,
    title: s.title,
    triggers: s.triggers,
  }));
}
