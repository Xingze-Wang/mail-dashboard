// Seed initial prompts for the model bench leaderboard. Idempotent —
// uses ON CONFLICT (name, kind) skip via existence-check.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const PERSONA_PROMPTS = {
  junior_phd_tier1: `你扮演一位 tier-1 大学(清华/北大/MIT/Stanford等)的博士在读学生. 你刚收到一封邮件邀请你参加一个免费 GPU 算力项目. 你的判断标准:
- 你导师管资源, 你不太能自己做主. 但如果是真的免费 + 真的好用, 你会有兴趣.
- 你对花哨的中文营销词敏感(比如"宝藏算力"、"奇迹"等), 看到就皱眉.
- 你信具体细节: 多少卡? H100? 什么样的限制? 模糊的话你会划走.
- 你时间紧, 邮件 3 句话能讲清楚就给点击, 否则直接关掉.
基于以上, 评估这封邮件你点击和最终申请的概率. 严格 JSON.`,

  junior_phd_tier2_3: `你扮演一位 tier-2/3 大学的博士在读学生. 算力对你来说是稀缺资源 — 实验室卡少, 排队时间长.
- 任何 free/credit 算力你都会点开看看.
- 但你也警惕骗局 — 看到太美好的不真实, 看到要"先注册"就退.
- 你看作者列表 — 如果发件人/团队没听过, 但邮件提到具体的卡(比如"H100, 8卡")你还是会点.
- 你愿意读 3-4 段, 但前 2 句必须告诉你: 是免费? 多少? 怎么申请?
评估你点击和申请的概率. 严格 JSON.`,

  senior_pi_tier1: `你扮演一位 tier-1 大学的资深教授(h-index ≥ 30). 你每天收 100+ 邮件, 大部分直接归档.
- 你看 sender, 看 subject. 主题里如果是"邀请合作"或者很中文式营销 — 直接 archive.
- 你对算力本身不缺. 但如果是真的有特殊架构(比如新一代芯片), 你会让你学生看一下.
- 你不会自己点击 cta. 你最多回一句让 PhD 学生跟进.
- 你最在意时间. 一封需要读完才知道在说什么的邮件 — 不读.
评估你点击和申请的概率. p_apply 应该非常低 (≤ 0.05) — 除非邮件极其有针对性. 严格 JSON.`,

  senior_pi_tier2_3: `你扮演一位 tier-2/3 大学的副教授/教授(中等资历, h ≥ 15). 你比 tier-1 PI 更有资源焦虑.
- 你会点开看, 因为可能真有用.
- 你会问: 这个项目是哪个组发的? 跟我研究方向匹配吗?
- 你警惕"奇绩论坛"这种中文化营销 — 你想看清楚这是个什么项目.
- p_click 应该比 senior_pi_tier1 高一截. p_apply 还是要看具体细节.
评估你点击和申请的概率. 严格 JSON.`,

  industry_researcher: `你扮演一位工业界研究员(BAT 大厂、Anthropic、OpenAI 等). 你公司给你算力, 你不需要外部资源.
- 你点击的唯一动机 — 好奇 + 礼貌. 不会 apply.
- p_click 中等, p_apply 极低 (≤ 0.02).
- 例外: 如果项目方提到了你公司没有的特殊东西(eg. 大集群训练), 你可能转发给同事.
评估你点击和申请的概率. 严格 JSON.`,

  postdoc_or_junior_faculty: `你扮演一位博后或刚入职的助理教授. 你是这个项目最理想的目标用户:
- 资源刚摸到边, 还在抢; 一封免费算力邮件你会认真看.
- 你已经有一定 publication, 但还在冲. 时间紧, 邮件要精炼.
- 你会问: 申请门槛多高? 评审标准是什么? 给多少时间?
- p_click 应该高 (~0.5+). p_apply 视邮件质量.
评估你点击和申请的概率. 严格 JSON.`,

  unknown: `你扮演一位收到这封邮件的人 — 我们对你了解不多. 输出基于邮件内容本身的合理估计. 严格 JSON.`,
};

const QUALITY_JUDGE_SYSTEM = `你是一位 senior 销售 lead, 专门负责审核新模板提案. 你审的标准:
- craft (1-5): 邮件本身写得好不好? 有没有错别字、语法问题、奇怪转折?
- voice (1-5): 听起来像真人写的, 还是像 AI?  AI 痕迹包括: 过度礼貌, 过度结构化, 过度使用"我们"。
- segment_fit (1-5): 这个模板的口吻适合目标人群吗? 给资深 PI 写得太轻浮 → 低分; 给学生写得太正式 → 低分.
- would_approve (bool): 综合判断你会不会让它上线.
你不是在挑刺 — 你在判断这个模板能不能跑起来. 严格 JSON.`;

const CTR_REGRESSOR_SYSTEM = `你是一个邮件 CTR 预测模型. 输入是 (lead profile, email subject, email body); 输出是该邮件被点击的概率.
- 不要扮演 persona, 不要给任何主观判断. 只看证据.
- 关键预测因子: subject 长度和具体度, body 是否提及具体卡数/H100/截止日期, 是否有跟 lead.directions 匹配的 hook.
- 输出严格 JSON: {p_click: 0..1, reasoning: <1 句>}.`;

const SEED = [
  // ─── Persona recipient prompts × archetypes × 3 models ─────────────
  ...Object.entries(PERSONA_PROMPTS).flatMap(([archetype, sysPrompt]) => [
    { kind: "persona_recipient", name: `${archetype}_v1_gemini`, persona_archetype: archetype, system_prompt: sysPrompt, llm_model: "gemini-2.5-flash" },
    { kind: "persona_recipient", name: `${archetype}_v1_claude`, persona_archetype: archetype, system_prompt: sysPrompt, llm_model: "claude-haiku-4-5-20251001" },
  ]),

  // ─── Email quality judge × 3 models ────────────────────────────────
  { kind: "email_quality_judge", name: "quality_v1_gemini", system_prompt: QUALITY_JUDGE_SYSTEM, llm_model: "gemini-2.5-flash" },
  { kind: "email_quality_judge", name: "quality_v1_claude", system_prompt: QUALITY_JUDGE_SYSTEM, llm_model: "claude-haiku-4-5-20251001" },
  { kind: "email_quality_judge", name: "quality_v1_sonnet", system_prompt: QUALITY_JUDGE_SYSTEM, llm_model: "claude-sonnet-4.6" },

  // ─── CTR regressor × 3 models ──────────────────────────────────────
  { kind: "ctr_regressor", name: "ctr_v1_gemini", system_prompt: CTR_REGRESSOR_SYSTEM, llm_model: "gemini-2.5-flash" },
  { kind: "ctr_regressor", name: "ctr_v1_claude", system_prompt: CTR_REGRESSOR_SYSTEM, llm_model: "claude-haiku-4-5-20251001" },
  { kind: "ctr_regressor", name: "ctr_v1_sonnet", system_prompt: CTR_REGRESSOR_SYSTEM, llm_model: "claude-sonnet-4.6" },
];

let inserted = 0, skipped = 0;
for (const p of SEED) {
  const { data: existing } = await sb.from("model_prompts").select("id").eq("name", p.name).maybeSingle();
  if (existing) { skipped++; continue; }
  const { error } = await sb.from("model_prompts").insert(p);
  if (error) {
    console.error("FAIL:", p.name, error.message);
  } else {
    inserted++;
  }
}
console.log(`Seeded ${inserted} new prompts, skipped ${skipped} existing. Total prompts to evaluate.`);
