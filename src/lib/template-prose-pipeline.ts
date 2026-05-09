/**
 * Strategist + editor pipeline for turning a *change_spec* (abstract
 * "swap school_pitch to emphasize prestige") into a concrete email
 * template paragraph (the actual Chinese prose) that's been brand-DNA
 * gated.
 *
 * Used by:
 *   - weekly congress (when its synthesizer's change_spec.kind is
 *     template_phrase_swap / subject_line_test, we call this to
 *     produce the actual swap text)
 *   - any future direct-admin path ("admin types a hypothesis, get
 *     a draft + editor verdict back")
 *
 * Why this module is separate: the standalone congress-hypothesis
 * runner has been retired (consolidated into weekly congress). Weekly
 * congress is the canonical multi-persona deliberation; this module
 * is the one-paragraph-craft phase that lives downstream of any
 * deliberation system.
 */

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";
import { BRAND_DNA } from "@/lib/brand-dna";

const STRATEGIST_SYSTEM = `${BRAND_DNA}

# 你的角色

你是 奇绩算力 program 的内容编辑. 收到 (a) 一段需要改的目标 hypothesis 或 change_spec, (b) 当前 baseline 模板某一段内容. 任务: 起草新版本的那一段, 用来 A/B 测试.

# 任务要求 (品牌 DNA 在上面, 这里只补技术性约束)
1. **占位符严格保留**: {{rep_name}}, {{closing_name}}, {{rep_wechat}}, {{title}}, {{abstract}}, {{base_info}}, {{school_text}}, {{directions_text}}, {{wechat_article_url}}, {{apply_url}}, {{REP_NAME}}, {{REP_WECHAT}}, {{CLOSING_NAME}}. 不展开, 不删.
2. 改动要**具体响应 hypothesis** 的判断, 不是泛泛"更友好"或"更短".
3. 跟原段落 register 一致, 不要突然换 register.

输出 JSON (只返回 JSON, 不要 markdown fence):
{
  "new_paragraph": "新版本的那一段, 完整文本",
  "what_changed": "1 句话: 你改了什么 + 为什么对应 hypothesis",
  "expected_pitfall": "1 句话: 这个改动可能在什么场景下反而更糟"
}`;

const EDITOR_SYSTEM = `你是奇绩创坛的主编, 现在审核一段即将进入 A/B 测试池的邮件正文段落. 这是冷启动邮件, 给做 AI 研究的研究员介绍**免费 GPU 算力**项目.

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

软标准 (累积 ≥3 个 → revise):
- 段落 > 150 字 (太长, 拆或砍)
- 一段中超过 2 个核心观点
- 加粗 > 3 处
- 同类形容词堆砌 (e.g. "高效, 强大, 灵活")
- 任何让段落读起来像广告而不是同行通知的修辞

输出严格 JSON (无 markdown fence):
{
  "verdict": "pass" | "revise" | "reject",
  "issues": [
    { "severity": "red" | "yellow", "rule": "<触发的红线编号或软标准描述>", "evidence": "<具体引用段落里的字句>", "suggestion": "<怎么改>" }
  ],
  "tone_assessment": "<1-2 句话: 这段语气是否符合 务实 / 坦然 / 简朴 / 谦逊, 哪一项不符>"
}

verdict 规则:
- 任一红线触发 → reject (issues 里给具体证据)
- 0 红线 + ≤2 个软标准 → pass
- 0 红线 + ≥3 个软标准 → revise
- pass 时 issues 可以是空数组`;

export const FORKABLE_SLOTS = [
  "subject_format",
  "intro_prompt",
  "greeting_format",
  "rep_intro_format",
  "school_pitch_format",
  "cta_signoff_format",
] as const;
export type ForkableSlot = typeof FORKABLE_SLOTS[number];

export interface StrategistResult {
  new_paragraph: string;
  what_changed: string;
  expected_pitfall: string;
}

interface EditorIssue {
  severity: "red" | "yellow";
  rule: string;
  evidence: string;
  suggestion: string;
}
export interface EditorReview {
  verdict: "pass" | "revise" | "reject";
  issues: EditorIssue[];
  tone_assessment: string;
}

/**
 * Strategist call. Drafts a new paragraph for the given slot, given
 * the hypothesis text + baseline content. JSON-repair fallback if
 * Gemini returns malformed output.
 */
export async function draftParagraph(args: {
  hypothesis: string;
  reasoning?: string;
  proposed_test?: string;
  slot: ForkableSlot;
  baselineContent: string;
}): Promise<StrategistResult | { error: string }> {
  const userPrompt = `# Hypothesis
${args.hypothesis}

${args.reasoning ? `# Reasoning\n${args.reasoning}\n\n` : ""}${args.proposed_test ? `# Proposed test\n${args.proposed_test}\n\n` : ""}# Slot to mutate
\`${args.slot}\`

# Current baseline content for that slot
${args.baselineContent}`;

  const tryParse = (raw: string): StrategistResult | null => {
    try {
      const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
      const parsed = JSON.parse(clean) as StrategistResult;
      if (typeof parsed.new_paragraph === "string" && parsed.new_paragraph.length > 0) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  try {
    // 4500 tokens because gemini-3-flash on this proxy burns
    // reasoning tokens on long Chinese prompts (the BRAND_DNA prepend
    // is ~1500 chars). Smaller budgets get truncated mid-JSON,
    // failing both direct parse AND repair. Same bump as the live
    // intro_prompt generator (template-assembler.ts).
    const r = await llmChat({
      model: "gemini-3-flash",
      system: STRATEGIST_SYSTEM,
      user: userPrompt,
      temperature: 0.4,
      max_tokens: 4500,
    });
    const direct = tryParse(r.text ?? "");
    if (direct && direct.new_paragraph !== args.baselineContent) return direct;

    // Repair pass for truncated/malformed JSON.
    const repair = await llmChat({
      model: "gemini-3-flash",
      system: "You are a JSON repair tool. Return valid JSON only, dropping any incomplete trailing fields.",
      user: `Repair this JSON:\n\n${(r.text ?? "").slice(0, 4000)}`,
      temperature: 0,
      max_tokens: 4500,
    });
    const repaired = tryParse(repair.text ?? "");
    if (repaired && repaired.new_paragraph !== args.baselineContent) return repaired;

    // Log raw output preview for debugging when both parses fail.
    const headRaw = (r.text ?? "").slice(0, 400);
    console.error(`[template-prose-pipeline] strategist parse fail. finish=${r.meta.finish_reason} tokens_out=${r.meta.tokens_out} head: ${headRaw}`);
    return { error: `strategist returned no-op or unparseable output (finish=${r.meta.finish_reason}, even after repair)` };
  } catch (e) {
    return { error: `strategist call failed: ${(e as Error).message}` };
  }
}

/**
 * Editor gate. Reviews a candidate paragraph against 奇绩 brand
 * standards. Returns a verdict; caller decides whether to insert,
 * trigger a revision pass, or reject outright.
 *
 * Fail-safe: if the editor LLM call itself errors or returns malformed
 * JSON, returns 'revise' (not 'pass') — better human review than
 * silent pass of unchecked content.
 */
export async function editParagraph(args: {
  paragraph: string;
  slot: string;
}): Promise<EditorReview> {
  const tryParse = (raw: string): EditorReview | null => {
    try {
      const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
      const parsed = JSON.parse(clean) as EditorReview;
      if (!parsed.verdict || !Array.isArray(parsed.issues)) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const userPrompt = `# 待审段落 (slot: ${args.slot})

${args.paragraph}

# 你的任务
按 EDITOR_SYSTEM 里的红线 + 软标准审查这段. 输出严格 JSON.`;
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: EDITOR_SYSTEM,
      user: userPrompt,
      temperature: 0.1,
      max_tokens: 4000,
    });
    const direct = tryParse(r.text ?? "");
    if (direct) return direct;

    // Repair pass.
    try {
      const repair = await llmChat({
        model: "gemini-3-flash",
        system: "You are a JSON repair tool. Return valid JSON only, dropping any incomplete trailing fields.",
        user: `Repair this editor verdict JSON:\n\n${(r.text ?? "").slice(0, 3500)}`,
        temperature: 0,
        max_tokens: 4000,
      });
      const repaired = tryParse(repair.text ?? "");
      if (repaired) return repaired;
    } catch {
      // fall through
    }

    return {
      verdict: "revise",
      issues: [{ severity: "yellow", rule: "editor returned unparseable verdict", evidence: (r.text ?? "").slice(0, 100), suggestion: "human review" }],
      tone_assessment: "(editor self-failure; needs human review)",
    };
  } catch (e) {
    return {
      verdict: "revise",
      issues: [{ severity: "yellow", rule: "editor unavailable", evidence: (e as Error).message.slice(0, 100), suggestion: "retry or human review" }],
      tone_assessment: "(editor call failed; needs human review)",
    };
  }
}

/**
 * Pick the right baseline template for a target segment (or fall back
 * to global if no segment-specific template exists).
 */
export async function pickBaselineTemplate(segment: string | null): Promise<{
  id: string;
  name: string;
  subject_format: string;
  intro_prompt: string;
  greeting_format: string;
  rep_intro_format: string;
  school_pitch_format: string;
  cta_signoff_format: string;
} | null> {
  if (segment) {
    const { data } = await supabase
      .from("email_templates")
      .select("id, name, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format")
      .eq("status", "active")
      .eq("active", true)
      .eq("segment_default", segment)
      .maybeSingle();
    if (data) return data as Awaited<ReturnType<typeof pickBaselineTemplate>>;
  }
  const { data: global } = await supabase
    .from("email_templates")
    .select("id, name, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format")
    .eq("status", "active")
    .eq("active", true)
    .eq("name", "global")
    .maybeSingle();
  return (global as Awaited<ReturnType<typeof pickBaselineTemplate>>) ?? null;
}

/**
 * Heuristic: which slot does a hypothesis/change_spec want to mutate?
 * Falls back to school_pitch_format (highest-leverage paragraph per
 * design doc) when the description doesn't clearly name a slot.
 */
export function inferSlotFromDescription(desc: string): ForkableSlot {
  const SLOT_KEYWORDS: Record<ForkableSlot, string[]> = {
    intro_prompt: ["intro", "personal", "开场", "开头", "personalized intro"],
    school_pitch_format: ["school", "学校", "pitch", "name-drop", "MIT", "清华", "校园"],
    rep_intro_format: ["rep_intro", "rep intro", "我是", "introduction", "self_introduce"],
    cta_signoff_format: ["cta", "signoff", "申请", "微信", "结尾", "closing"],
    subject_format: ["subject", "标题", "subject_line"],
    greeting_format: ["greeting", "称呼", "你好", "salutation"],
  };
  const lc = desc.toLowerCase();
  for (const [slot, words] of Object.entries(SLOT_KEYWORDS)) {
    if (words.some((w) => lc.includes(w.toLowerCase()))) {
      return slot as ForkableSlot;
    }
  }
  return "school_pitch_format";
}

/**
 * End-to-end: take a hypothesis description + (optional) target
 * segment, produce a brand-DNA-gated paragraph, and insert into
 * email_templates as status='proposal'. Returns the inserted row id
 * on success, or an error reason.
 *
 * Used by:
 *   - weekly congress when its synthesizer's change_spec.kind is
 *     template-related
 *   - hypothesis-driven runner (now a thin wrapper)
 *
 * Two-step flow: strategist drafts → editor reviews. If editor says
 * 'revise', one strategist re-pass with editor's notes, then re-edit.
 * If still not 'pass', returns reject.
 */
export async function craftAndGateProposal(args: {
  hypothesis: string;
  reasoning?: string;
  proposed_test?: string;
  segment: string | null;
  slot?: ForkableSlot;
  proposedBy: "congress" | "admin" | "leon";
  evidence?: Record<string, unknown>;
  /** When the proposal originates from a tactical_proposals row, link them. */
  tacticalProposalId?: string | null;
}): Promise<{ ok: true; templateId: string; name: string } | { ok: false; error: string }> {
  const baseline = await pickBaselineTemplate(args.segment);
  if (!baseline) return { ok: false, error: "no baseline template" };

  const slot = args.slot ?? inferSlotFromDescription(
    `${args.hypothesis} ${args.proposed_test ?? ""}`,
  );
  const baselineContent = (baseline as Record<string, string>)[slot];
  if (!baselineContent) return { ok: false, error: `slot ${slot} missing on baseline` };

  // Strategist draft
  const drafted = await draftParagraph({
    hypothesis: args.hypothesis,
    reasoning: args.reasoning,
    proposed_test: args.proposed_test,
    slot,
    baselineContent,
  });
  if ("error" in drafted) return { ok: false, error: drafted.error };

  // Editor review
  let attempt = drafted.new_paragraph;
  let attemptChanged = drafted.what_changed;
  let attemptPitfall = drafted.expected_pitfall;
  let review = await editParagraph({ paragraph: attempt, slot });

  // One revision pass if editor says revise
  if (review.verdict === "revise") {
    const issuesText = review.issues
      .map((i, idx) => `${idx + 1}. [${i.severity}] ${i.rule}\n   evidence: ${i.evidence}\n   suggestion: ${i.suggestion}`)
      .join("\n");
    const revised = await draftParagraph({
      hypothesis: `${args.hypothesis}\n\n# Editor's previous issues to fix\n${issuesText}\n\n# Your previous draft (rewrite to address every issue)\n${attempt}`,
      slot,
      baselineContent,
    });
    if (!("error" in revised)) {
      attempt = revised.new_paragraph;
      attemptChanged = revised.what_changed;
      attemptPitfall = revised.expected_pitfall;
      review = await editParagraph({ paragraph: attempt, slot });
    }
  }

  if (review.verdict !== "pass") {
    return {
      ok: false,
      error: `editor ${review.verdict}: ${review.issues.map((i) => `[${i.severity}] ${i.rule}`).join("; ") || "(no issues listed)"}`,
    };
  }

  // Insert as proposal
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const proposalName = args.tacticalProposalId
    ? `proposal_t${args.tacticalProposalId.slice(0, 8)}_${slot}_${today}`
    : `proposal_${slot}_${today}_${Math.random().toString(36).slice(2, 8)}`;

  const insertRow: Record<string, unknown> = {
    name: proposalName,
    rep_id: null,
    active: true,
    status: "proposal",
    segment_default: args.segment,
    proposed_by: args.proposedBy,
    proposed_reason: `${attemptChanged}\n\nHypothesis: ${args.hypothesis}\n\nExpected pitfall: ${attemptPitfall}\n\nEditor: ${review.tone_assessment}`,
    proposed_evidence: {
      ...args.evidence,
      slot_swapped: slot,
      baseline_template_id: baseline.id,
      what_changed: attemptChanged,
      expected_pitfall: attemptPitfall,
      editor_tone_assessment: review.tone_assessment,
      tactical_proposal_id: args.tacticalProposalId ?? null,
    },
    notes: `Generated via template-prose-pipeline. Mutates ${slot} of "${baseline.name}". Passed editor gate.`,
    subject_format: baseline.subject_format,
    intro_prompt: baseline.intro_prompt,
    greeting_format: baseline.greeting_format,
    rep_intro_format: baseline.rep_intro_format,
    school_pitch_format: baseline.school_pitch_format,
    cta_signoff_format: baseline.cta_signoff_format,
  };
  insertRow[slot] = attempt;

  const { data: created, error } = await supabase
    .from("email_templates")
    .insert(insertRow)
    .select("id, name")
    .single();
  if (error || !created) return { ok: false, error: error?.message ?? "insert failed" };

  return { ok: true, templateId: created.id as string, name: created.name as string };
}
