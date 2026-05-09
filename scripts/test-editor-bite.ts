/**
 * Does the editor (裁判) actually catch bad copy, or rubber-stamp?
 * Test by feeding it BOTH known-bad and known-good paragraphs and
 * checking the verdict.
 */
import { llmChat } from "../src/lib/llm-proxy";

const EDITOR_SYSTEM_INLINE = `你是奇绩创坛的主编, 现在审核一段即将进入 A/B 测试池的邮件正文段落. 这是冷启动邮件, 给做 AI 研究的研究员介绍**免费 GPU 算力**项目.

记住基本判断:
- 这不是销售推文. 我们不是 salespeople. 这是免费算力, 给真正在做研究的人.
- 邮件目的: 让收件人 30 秒内 get 到"我能不能用上 / 跟我有没有关系", 而不是被说服.
- 写得不好的段落 (吹捧, 煽动, 自夸, 用词过 / 过卑) 比不发更糟 — 那是失信于品牌.

红线 (任一触发即 reject):
1. 错别字 / 错误标点 / 语病
2. 销售话术或夸大: "立即/火热/独家/震撼/重磅/最强/顶级/行业领先/国内首家"
3. 卑微 / 过热称谓: "您"/"您们"/"亲爱的"/"敬爱的"/"尊敬的"
4. 自夸: 不能让段落读起来像在自我表扬
5. 内部代号 (S23/F24 这种): 必须用读者能理解的表述
6. 数字与 program facts 不符 (program facts: 单项目最高 100 万等值算力 / 通过率约 1.5% / 完全免费 / 不占股 / 不要求署名)
7. 流量话术: "点击查看"/"扫码立即报名"/"不容错过"
8. 第一/第二人称代词滥用 (重点检查: 第一人称连用 3 次以上常常是过度煽情)
9. 主观模糊词: "感觉"/"似乎"/"应该"/"或许" — 邮件不要这些
10. 占位符被破坏 ({{...}} 形式必须完整保留)
11. 让收件人解释自己的论文 (语义荒谬 — 收件人 IS the author)

输出严格 JSON:
{ "verdict": "pass" | "revise" | "reject", "issues": [ { "severity": "red" | "yellow", "rule": "...", "evidence": "...", "suggestion": "..." } ], "tone_assessment": "..." }`;

const TEST_CASES = [
  {
    label: "GOOD — clean peer-register intro",
    paragraph: "最近在跟踪细粒度动作识别的研究时, 读到你的 TemPose-TF-ASF paper, 其中双向时序上下文融合解决动作分类时序建模的方案很有启发, 如果能有更多算力支持, 相信可以在更大规模的体育赛事数据集上验证算法的泛化能力.",
    expected: "pass",
  },
  {
    label: "BAD — uses 您 + asks author to explain own paper",
    paragraph: "亲爱的作者您好, 感谢您贡献了这篇精彩的论文. 能否请您说明一下您文中哪一部分是关键, 我们对您的工作非常感兴趣.",
    expected: "reject",
  },
  {
    label: "BAD — sales talk + superlatives",
    paragraph: "震撼推出！奇绩算力是国内首家最强的免费算力平台, 立即点击查看, 独家机会不容错过！",
    expected: "reject",
  },
  {
    label: "BAD — self-aggrandizing + facts wrong",
    paragraph: "我们是国内顶级、行业领先的算力提供商, 单项目支持 200 万元额度, 已经获得无数研究者的赞誉.",
    expected: "reject",
  },
  {
    label: "BORDERLINE — slightly stiff, no red lines",
    paragraph: "{{school_text}}（{{base_info}}）{{directions_text}}. 奇绩算力的特点是审核严格 (通过率约 1.5%), 但额度较多, 且完全免费 (不占股, 不要求署名).",
    expected: "pass",
  },
  {
    label: "BAD — kowtow tone with 敬爱的",
    paragraph: "敬爱的{{closing_name}}老师, 我们怀着崇敬的心情向您介绍我们的算力支持项目, 期待您的回复.",
    expected: "reject",
  },
];

async function main() {
  console.log(`\nTesting editor against ${TEST_CASES.length} cases:\n`);
  let correct = 0;
  for (const tc of TEST_CASES) {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: EDITOR_SYSTEM_INLINE,
      user: `# 待审段落\n\n${tc.paragraph}\n\n按系统中红线 + 软标准审查. 输出严格 JSON.`,
      temperature: 0.1,
      max_tokens: 2500,
    });
    const clean = (r.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    let verdict = "?";
    let issues: { severity: string; rule: string }[] = [];
    try {
      const parsed = JSON.parse(clean);
      verdict = parsed.verdict;
      issues = parsed.issues ?? [];
    } catch {
      verdict = "PARSE_ERROR";
    }
    const matched = verdict === tc.expected || (tc.expected === "reject" && verdict === "reject");
    const mark = matched ? "✅" : "❌";
    if (matched) correct++;
    console.log(`${mark} ${tc.label}`);
    console.log(`   expected: ${tc.expected}  got: ${verdict}  (${issues.length} issues)`);
    if (issues.length > 0 && issues.length <= 3) {
      for (const i of issues.slice(0, 3)) {
        console.log(`     - [${i.severity}] ${i.rule}`);
      }
    }
    console.log();
  }
  console.log(`\nEditor accuracy: ${correct}/${TEST_CASES.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
