-- ═══════════════════════════════════════════════════════════════════
-- Migration 011: Seed the "global" email template
--
-- Mirrors email-generator.ts's current hardcoded output exactly, so
-- the template-driven assembler produces byte-identical drafts to the
-- pre-refactor code when no per-rep template exists.
--
-- Keep in sync with src/lib/email-generator.ts:
--   - subject_format: line 272
--   - greeting_format: lines 239-240
--   - rep_intro_format: line 280
--   - school_pitch_format: lines 104-108 (generateThirdParagraph)
--   - cta_signoff_format: lines 282-283
--
-- Re-runs are safe: uses ON CONFLICT (name) DO UPDATE so edits to this
-- seed file will overwrite the row on re-migration. Manual edits in
-- Supabase will therefore be lost on next deploy — if you want to
-- customize the global template, use the Templates UI and make a new
-- non-"global" row OR turn this migration into a one-shot insert with
-- ON CONFLICT DO NOTHING (decide based on how you want ownership to
-- work). For now, "this migration is the source of truth" is simpler.
-- ═══════════════════════════════════════════════════════════════════

insert into email_templates (name, rep_id, active, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, notes)
values (
  'global',
  null,
  true,
  'Invitation to Apply - {{title}}的潜在算力支持机会',
  $PROMPT$根据论文写一句个性化开头（1句话）。

标题: {{title}}
摘要: {{abstract}}

格式：最近在跟踪A方向的研究时，读到你的X paper，其中用Y方法（不要超过8个字）解决Z问题（9个字以内）的方案很有启发。如果能有更多算力支持，相信可以（提供更多insights，更大程度上验证方法的普适性等，这里可以看一下作者可能希望做到的事情，写一下如果有更多算力做到什么）。

**任何情况下，严禁出现""，*，//，%，$等任何符号**

注意：
1. A方向
- 这里需要找一个相对大一些的领域（e.g. Dyna网状Web agent架构 -> Web Agent方向研究）
- 第二个例子：Principle-Evolvable Scientific Discovery via Uncertainty Minimization -> AI4S相关
- 此外，要学会使用更加常用的表达（e.g. Offline Reinforcement Learning就说Offline RL，不要说离线强化学习）

错误例子：
- 最近在跟踪RAG查询优化研究 - 不像人话
- 推荐系统解释性 - 应该是推荐系统可解释性，人类不会说"解释性"这种词，而是"可解释性"

正确例子：
- 最近在整理可解释性领域的最新进展
- 最近在跟踪Agentic RL相关的研究
- 最近在跟踪持续学习方向的工作

2. X paper
- 如果论文标题是 xx: xxxx，那么用：前面的部分即可 （e.g. RobustExplain: Evaluating Robustness of LLM-Based Explanation Agents for Recommendation -> RobustExplain paper)
- 如果论文标题没有冒号，直接用《完整标题》，e.g. 读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》，其中用...
- 如果论文标题过长（超过10个英文单词），可以简化为"你的关于YYY的论文"，YYY是论文的核心内容，不直接用标题。

3. Y方法解决Z问题 - 不要超过12个字
- option a: 基于Y方法，解决Z问题
- option b: 解释了xx现象 / 深入分析了xx问题 / 揭示了xx机制

**注意：一定是三段论，每一个部分中间有逗号（最近在...，读到了...，其中）**

正确例子：
- 最近在跟踪持续学习方向的工作，读到了你的关于平衡模型稳定性和可塑性的论文，揭示了经验回放(ER)在不同任务上的二元性，很有启发。文中指出了经验回放会导致代码生成等结构化任务的负迁移，如果能在更大规模的模型上验证，相信能提供更多关于持续学习的 insights。
- 最近在跟踪可解释性相关研究时，读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》，其中用基于Shapley值进行多维度归因的方法解决解释multi-agent system涌现极端事件的方案很有启发。
- 最近在跟踪Web Agent相关研究时，读到你的DynaWeb paper，其中通过学习一个网络世界模型作为合成环境的方案很有启发。

只返回这一句话。$PROMPT$,
  '{{first_name_or_you}}你好，',
  '我是奇绩创坛的{{rep_name}}。针对具备高潜力的前沿科研项目，奇绩算力计划目前正开放新一轮的申请，希望能通过免费算力，将科研的固定成本转变为边际成本，助力前沿想法的快速验证。',
  '{{school_text}}（{{base_info}}）{{directions_text}}。奇绩算力的特点是审核严格（通过率约1.5%），但额度较多，且完全免费（不占股，不要求署名，详见 {{wechat_article_url}} ）。',
  '如果{{closing_name}}对算力支持感兴趣，欢迎<a href="{{apply_url}}">申请</a>或加我微信交流（{{rep_wechat}}）。',
  'Baseline global template — mirrors email-generator.ts hardcoded output as of migration 011.'
)
on conflict (name) do update set
  subject_format     = excluded.subject_format,
  intro_prompt       = excluded.intro_prompt,
  greeting_format    = excluded.greeting_format,
  rep_intro_format   = excluded.rep_intro_format,
  school_pitch_format= excluded.school_pitch_format,
  cta_signoff_format = excluded.cta_signoff_format,
  notes              = excluded.notes,
  updated_at         = now();
