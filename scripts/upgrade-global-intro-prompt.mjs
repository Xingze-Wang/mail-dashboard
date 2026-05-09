/**
 * Rewrite the global template's intro_prompt with hardened anti-bug
 * instructions. The user surfaced two specific failure modes Gemini
 * was producing despite the existing prompt:
 *   1. Using "您" (banned in brand DNA but the prompt didn't enforce it)
 *   2. Asking the recipient to explain their own paper ("能否请您说明
 *      一下您文中哪一部分") — semantic absurdity since recipient IS
 *      the author
 *
 * Original prompt instructed shape but didn't ban these patterns. Now:
 *   - Explicit posture line at the top
 *   - 称谓 must be 你 (peer), never 您
 *   - NEVER ask the author to explain / introduce / clarify their work
 *   - 3 concrete examples of bad output to avoid
 *   - 3 concrete examples of good output
 *
 * Idempotent — running twice produces the same prompt.
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const NEW_INTRO_PROMPT = `# 任务
为一封冷启动邮件写第一段（1 句话开头）。这封邮件的目的是告诉这位作者奇绩有免费 GPU 算力可以申请。

# 收件人
**这位作者就是我下面给你的论文的作者本人**。他们写了这篇论文。所以:
- ✅ 提到他们这篇论文 = 表示我读过, 以专业身份切入
- ❌ 不能"感谢他们写这篇论文" — 我们不是审稿人或粉丝
- ❌ 不能"让他们解释自己的论文" — 他们已经知道自己写了什么, 我不能问"能否请你说明一下你文中哪一部分"
- ❌ 不能"为他们的工作介绍背景" — 他们是这个领域的专家, 不需要我给他们科普

# 姿态 (写之前先看)
- **称谓: 永远用"你", 不要用"您"**. 这是奇绩的硬性品牌规则.
- 平等同行的语气, 不是销售也不是粉丝. 想象自己是同领域的研究员告诉同行"我看到你的工作, 我们这有免费算力, 觉得可能跟你的研究方向对得上".
- 不夸大, 不煽动. 不用"震撼""独家""最强"这种词.
- 不卑微. 不用"亲爱的""敬爱的".

# 输入
标题: {{title}}
摘要: {{abstract}}

# 输出格式
严格三段论, 用逗号连接成一句话:

"最近在跟踪[方向]的研究时, 读到你的[paper], 其中[Y方法]解决[Z问题]的方案很有启发. 如果能有更多算力支持, 相信可以[作者可能想做的事]."

具体要求:
- **方向**: 用领域常见说法 (e.g. "Web Agent" / "持续学习" / "AI4S"), 不要直译论文标题
- **paper 引用**: 标题如果有冒号, 用前半部分 (e.g. "RobustExplain: Eval..." → "RobustExplain paper"). 没有冒号, 用《完整标题》. 标题超 10 个英文词, 改成"你的关于 YYY 的论文"
- **Y 方法**: ≤ 12 字
- **Z 问题**: ≤ 12 字
- **如果能有更多算力**: 推断作者下一步可能想验证的事 — 通常是"在更大规模的 X 上验证方法普适性""在更复杂的 Y 任务下证实泛化能力". 别让这部分变成对论文的复述.

# 严禁
- ❌ "您" (永远用"你")
- ❌ "感谢""谢谢""thank"
- ❌ "请你说明""能否请你解释""能不能告诉我"等任何让作者解释自己工作的话
- ❌ "亲爱的""敬爱的""尊敬的"
- ❌ 引号""、星号 *、斜杠 //、百分号 %、美元 $ 等任何特殊符号
- ❌ "其实""然后""我觉得""你知道吗"等口语
- ❌ "震撼""独家""最强""顶级""国内首家"

# 错误示范 (不要产生这种)
1. "亲爱的作者您好, 感谢您贡献了这篇精彩的论文..." — 用了亲爱的+您+感谢+吹捧
2. "最近在跟踪 RAG 查询优化研究, 能否请您说明一下您文中哪一部分..." — 让作者解释自己工作
3. "推荐系统解释性" — 用词不像人话, 应是"可解释性"
4. "您的这篇论文非常优秀, 我们对您的工作非常感兴趣..." — 卑微 + 自夸 + 销售腔

# 正确示范
1. "最近在跟踪持续学习方向的工作, 读到了你的关于平衡模型稳定性和可塑性的论文, 揭示了经验回放(ER)在不同任务上的二元性, 很有启发. 文中指出了 ER 在代码生成等结构化任务上的负迁移, 如果能在更大规模的模型上验证, 相信能提供更多关于持续学习的 insights."
2. "最近在跟踪可解释性相关研究时, 读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》, 其中用基于 Shapley 值进行多维度归因的方法解决解释 multi-agent system 涌现极端事件的方案很有启发."
3. "最近在跟踪 Web Agent 相关研究时, 读到你的 DynaWeb paper, 其中通过学习一个网络世界模型作为合成环境的方案很有启发."

# 重要
只返回这一句话, 不要任何前言/解释/markdown/引号包围.`;

const { error } = await sb
  .from("email_templates")
  .update({
    intro_prompt: NEW_INTRO_PROMPT,
    updated_at: new Date().toISOString(),
  })
  .eq("name", "global")
  .eq("status", "active");

if (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}
console.log("✅ Updated global template intro_prompt.");
console.log(`   New length: ${NEW_INTRO_PROMPT.length} chars (was ~700).`);
console.log("   Banned patterns: 您 / 感谢作者 / 让作者解释 / 亲爱的 / 销售套词");
console.log("   Added: 6 concrete examples (3 bad, 3 good).");
