// Email draft generator — ported from resend0331.py lines 636-741.
//
// NOTE (2026-04-23): Draft assembly has moved behind
// `lib/template-assembler.ts`. generateDraft() now tries to load an
// active `email_templates` row for the assigned rep and, if one
// exists, delegates assembly to the template-driven path so per-rep
// voice + prompt customization become possible. The legacy
// hardcoded path below is kept as a fallback so the system keeps
// producing drafts when migrations 010/011 haven't been applied
// (e.g. during staged rollout). Once migrations are live in prod
// and the global template is verified byte-identical, we can start
// deleting the legacy bits here.
import {
  SCHOOL_DATA,
  APPLY_URL_CTA,
  WECHAT_ARTICLE_URL,
  type SchoolInfo,
} from "./scanner-config";
import { supabase } from "./db";
import { assembleDraft, loadEffectiveTemplate } from "./template-assembler";
import { applyAutoAb } from "./auto-ab";

// ============ HTML escaping ============

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ============ School info lookup (Python lines 562-571) ============

export function getSchoolInfo(email: string): SchoolInfo | null {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  if (SCHOOL_DATA[domain]) return SCHOOL_DATA[domain];
  const parts = domain.split(".");
  for (let i = 0; i < parts.length; i++) {
    const partial = parts.slice(i).join(".");
    if (SCHOOL_DATA[partial]) return SCHOOL_DATA[partial];
  }
  return null;
}

// ============ Sanitization (Python lines 610-624) ============

function sanitizeGeminiOutput(text: string): string {
  let t = text.trim();
  // Strip wrapping quotes (straight and curly)
  t = t.replace(/^[""\u201c]+/, "").replace(/[""\u201d]+$/, "");
  // Remove markdown bold/italic markers
  t = t.replace(/\*{1,3}(.+?)\*{1,3}/g, "$1");
  // Remove backticks
  t = t.replace(/`/g, "");
  // Remove leading bullet markers
  t = t.replace(/^[-•]\s*/, "");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function sanitizePersonalizedIntro(text: string): string {
  let t = sanitizeGeminiOutput(text);
  // Remove parenthetical notes about character counts / formatting instructions
  t = t.replace(/[（(][^）)]*(?:个字|字以内|以内|注意|格式|例子|option|段论)[^）)]*[）)]/g, "");
  t = t.replace(/[（(]\d+个?字[）)]/g, "");
  // Collapse double commas
  t = t.replace(/，\s*，/g, "，");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

// ============ matched_directions normalization ============

/**
 * Python's scanner sometimes writes `matched_directions` to the DB as a
 * JSON-encoded string (e.g. `'["具身3D空间理解","多模态内容解析"]'`) rather than
 * a proper text[] array. Old callers did `typeof === "string" ? split(",")
 * : array`, which on a JSON-string input produced `['["X"', '"Y"]']` — and
 * downstream `.join("、")` then output the raw JSON tokens (e.g.
 * `["具身3D..."、"多模态..."]`) into the email body.
 *
 * This helper handles all three shapes:
 *   - already an array → return as-is
 *   - JSON-encoded string starting with `[` → JSON.parse, return array
 *   - comma-separated string → split + trim
 *   - null / anything else → empty array
 */
export function normalizeMatchedDirections(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch {
        // fall through to comma-split
      }
    }
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

// ============ Subject line truncation ============

function truncateSubject(subject: string, maxLen = 200): string {
  if (subject.length <= maxLen) return subject;
  const trimmed = subject.slice(0, maxLen - 3);
  const lastSpace = trimmed.lastIndexOf(" ");
  return (lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed) + "...";
}

// ============ Third paragraph (Python lines 641-666) ============

function generateThirdParagraph(
  schoolInfo: SchoolInfo | null,
  matchedDirections: string[],
): string {
  const baseInfo = "单项目最高支持100万等值算力，相当于8卡H100连续跑15个月";

  let schoolText: string;
  if (schoolInfo) {
    const { count, name, tier } = schoolInfo;
    if (count >= 20) {
      schoolText = `过去一年中，我们支持了超过20位来自${name}的researcher`;
    } else if (count >= 15) {
      schoolText = `过去一年中，我们支持了接近20位来自${name}的researcher`;
    } else if (count >= 5) {
      schoolText = `过去一年中，我们支持了${count}位来自${name}的researcher`;
    } else {
      if (tier === 1) {
        schoolText = `过去一年中，我们支持了70+来自${name}、MIT、清华、北大等高校的项目`;
      } else {
        schoolText = `过去一年中，我们支持了70+来自MIT、清华、${name}等高校的项目`;
      }
    }
  } else {
    schoolText = "过去一年中，我们支持了70+前沿项目";
  }

  const directionsText =
    matchedDirections.length >= 2
      ? `，已经支持的研究方向包括${matchedDirections.join("、")}等`
      : "";

  return (
    `${escapeHtml(schoolText)}（${escapeHtml(baseInfo)}）${escapeHtml(directionsText)}。` +
    `奇绩算力的特点是审核严格（通过率约1.5%），但额度较多，且完全免费` +
    `（不占股，不要求署名，详见 ${WECHAT_ARTICLE_URL} ）。`
  );
}

// ============ Prompt template loading ============

export const DEFAULT_INTRO_PROMPT_NAME = "pipeline_intro_prompt";

/**
 * Load a prompt template from the DB (templates table).
 * Users can edit these via the Templates page.
 * Falls back to the hardcoded default if not found.
 */
async function loadPromptTemplate(name: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("templates")
      .select("html")
      .eq("name", name)
      .single();
    return data?.html || null;
  } catch {
    return null;
  }
}

// ============ Gemini personalized intro ============

export const DEFAULT_INTRO_PROMPT = `根据论文写一句个性化开头（1句话）。

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

只返回这一句话。`;

// Sentence terminators we accept as "complete". Includes both Chinese and
// ASCII sentence endings + closing quotes/parens. Anything else means the
// LLM stopped mid-sentence — never save that.
const SENTENCE_END_RE = /[。．\.!！?？]["'』」）)]?\s*$/;

function endsCompletely(text: string): boolean {
  return SENTENCE_END_RE.test(text.trim());
}

/**
 * Trim back to the last complete sentence boundary. If no sentence
 * terminator is present at all, returns empty string (caller should
 * regenerate, not save a fragment).
 */
function trimToLastCompleteSentence(text: string): string {
  const t = text.trim();
  // Find the last sentence-ender that's not the very end.
  const enders = /[。．\.!！?？]/g;
  let lastIdx = -1;
  for (const m of t.matchAll(enders)) {
    lastIdx = m.index! + m[0].length;
  }
  if (lastIdx <= 0) return "";
  return t.slice(0, lastIdx).trim();
}

async function generatePersonalizedIntro(
  title: string,
  abstract: string,
): Promise<string> {
  // Load user-customized prompt or fall back to default
  const customPrompt = await loadPromptTemplate(DEFAULT_INTRO_PROMPT_NAME);
  const promptTemplate = customPrompt || DEFAULT_INTRO_PROMPT;

  // Replace placeholders
  const prompt = promptTemplate
    .replace("{{title}}", title)
    .replace("{{abstract}}", abstract.slice(0, 1000));

  // If using the old hardcoded format (no {{title}} placeholder), use directly
  const finalPrompt = prompt.includes(title) ? prompt : `根据论文写一句个性化开头（1句话）。

标题: ${title}
摘要: ${abstract.slice(0, 1000)}

${prompt}`;

  const { llmChat } = await import("./llm-proxy");

  // Attempt 1: normal call.
  // Using gemini-3-flash-preview via llm-proxy alias "gemini-3-flash".
  // template-assembler.ts:204 already uses 3-flash; keep both in sync so
  // the same draft doesn't mix 2.5 + 3 voices.
  let r = await llmChat({
    model: "gemini-3.5-flash",
    user: finalPrompt,
    temperature: 0.5,
    max_tokens: 500,
    timeoutMs: 20_000,
  });
  let cleaned = sanitizePersonalizedIntro(r.text);

  // If the model returned a complete sentence, ship it.
  if (endsCompletely(cleaned)) return cleaned;

  // Retry once with more headroom — sometimes the model used the 500-token
  // budget on reasoning then truncated the actual reply. Bump to 1200.
  r = await llmChat({
    model: "gemini-3.5-flash",
    user: finalPrompt + "\n\n（注意：必须以句号结尾，不要中途截断。）",
    temperature: 0.5,
    max_tokens: 1200,
    timeoutMs: 25_000,
  });
  cleaned = sanitizePersonalizedIntro(r.text);
  if (endsCompletely(cleaned)) return cleaned;

  // Last resort: trim back to last complete sentence so we never save a
  // mid-sentence fragment. If no complete sentence exists at all, return
  // empty string — caller treats that as "no personalized intro" and uses
  // the generic fallback. Better to skip personalization than ship garbage.
  const trimmed = trimToLastCompleteSentence(cleaned);
  if (trimmed.length >= 20) return trimmed;
  return "";
}

// ============ Main export ============

export async function generateDraft(lead: {
  title: string;
  abstract: string;
  authorEmail: string;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  matchedDirections: string[];
  repName?: string;
  repWechatId?: string;
  // Optional — when provided, we look up a per-rep email_templates
  // row before falling back to the global template. Callers that
  // don't have repId (legacy code paths) still work: they just skip
  // per-rep overrides.
  assignedRepId?: number | null;
  // Pipeline lead id — used for deterministic A/B traffic splitting
  // in loadEffectiveTemplate. Without it, all rendering uses the
  // active template; with it, ~APPROVED_DRAFT_TRAFFIC_PCT% of leads
  // hit any active approved_draft template instead. Stable per-lead
  // so regenerates produce the same template assignment.
  leadId?: string | null;
}): Promise<{
  subject: string;
  html: string;
  templateId: string | null;
  // Threaded up from assembleDraft so send routes can stamp these
  // onto emails for analytics. Null when the legacy fallback path ran
  // (no resolved-prompt audit available there — legacy doesn't use a
  // template). See migration 062.
  introPromptResolved?: string | null;
  introOutput?: string | null;
}> {
  // Template-driven path — preferred. If either the migration hasn't
  // been applied or the table is empty, loadEffectiveTemplate returns
  // null and we fall through to the legacy hardcoded assembly below.
  const repName = lead.repName || "Leo";
  const repWechat = lead.repWechatId || "Lorenserus1";
  // Normalize matched_directions ONCE at the entry point. Python sometimes
  // writes this as a JSON-encoded string instead of a proper text[] array —
  // see normalizeMatchedDirections() docstring. Without this, downstream
  // .join("、") emitted raw JSON tokens into the email body.
  const matchedDirections = normalizeMatchedDirections(lead.matchedDirections);
  try {
    const tpl = await loadEffectiveTemplate(lead.assignedRepId ?? null, lead.leadId ?? null);
    if (tpl) {
      const draft = await assembleDraft(tpl, {
        title: lead.title,
        abstract: lead.abstract,
        authorEmail: lead.authorEmail,
        firstName: lead.firstName,
        schoolName: lead.schoolName,
        schoolTier: lead.schoolTier,
        matchedDirections,
        repName,
        repWechatId: repWechat,
      });
      // Auto-A/B (Dream #4): apply data-driven subject mutations for
      // reps who opted in. Returns the original subject if rep is
      // opt-out OR no high-confidence pattern matches this lead.
      if (lead.assignedRepId != null) {
        const ab = await applyAutoAb(draft.subject, {
          repId: lead.assignedRepId,
          authorEmail: lead.authorEmail,
          schoolTier: lead.schoolTier,
          matchedDirections,
        });
        return {
          subject: ab.subject,
          html: draft.html,
          templateId: tpl.id,
          introPromptResolved: draft.introPromptResolved,
          introOutput: draft.introOutput,
        };
      }
      return {
        subject: draft.subject,
        html: draft.html,
        templateId: tpl.id,
        introPromptResolved: draft.introPromptResolved,
        introOutput: draft.introOutput,
      };
    }
  } catch (err) {
    // Template path failed — fall through to legacy. Log so it's
    // visible but don't break draft generation.
    console.warn("generateDraft: template path failed, using legacy", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Legacy hardcoded path (kept for fallback) ───
  const schoolInfo = getSchoolInfo(lead.authorEmail);
  const greeting = lead.firstName
    ? `${escapeHtml(lead.firstName)}你好，`
    : "你好，";

  const personalizedIntro = await generatePersonalizedIntro(
    lead.title,
    lead.abstract,
  );
  const personalizedIntroHtml = escapeHtml(personalizedIntro);

  const thirdParagraph = generateThirdParagraph(
    schoolInfo,
    matchedDirections,
  );

  // Default to Leo only when the caller genuinely has no rep (should be rare —
  // every pipeline_leads row is assigned at insert time). Log when we fall back
  // so a silent Leo-default doesn't sneak past us. (repName / repWechat are
  // already defined above, shared with the template-driven path.)
  if (!lead.repName || !lead.repWechatId) {
    console.warn("generateDraft: missing rep identity, falling back to Leo", {
      authorEmail: lead.authorEmail,
      hasName: !!lead.repName,
      hasWechat: !!lead.repWechatId,
    });
  }

  const fullTitle = lead.title.replace(/\n/g, " ").trim();
  const closingName = lead.firstName
    ? escapeHtml(lead.firstName)
    : "你";

  let subject = truncateSubject(
    `Invitation to Apply - ${fullTitle}的潜在算力支持机会`,
  );
  // Auto-A/B in legacy path too — same opt-in rules apply.
  if (lead.assignedRepId != null) {
    const ab = await applyAutoAb(subject, {
      repId: lead.assignedRepId,
      authorEmail: lead.authorEmail,
      schoolTier: lead.schoolTier,
      matchedDirections: lead.matchedDirections,
    });
    subject = ab.subject;
  }

  const html = `<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; font-size: 14px; line-height: 1.8; color: #333;">
${greeting}<br><br>
${personalizedIntroHtml}<br><br>
我是奇绩创坛的${escapeHtml(repName)}。针对具备高潜力的前沿科研项目，奇绩算力计划目前正开放新一轮的申请，希望能通过免费算力，将科研的固定成本转变为边际成本，助力前沿想法的快速验证。<br><br>
${thirdParagraph}<br><br>
如果${closingName}对算力支持感兴趣，欢迎<a href="${APPLY_URL_CTA}">申请</a>或加我微信交流（${escapeHtml(repWechat)}）。<br><br>
<span style="font-size: 14px; color: #333; line-height: 1.6;">${escapeHtml(repName)}<br>奇绩创坛</span>
</body></html>`;

  return {
    subject,
    html,
    templateId: null,
    // Legacy path doesn't go through assembleDraft so we can't capture
    // the exact resolved prompt — return null. Downstream analytics
    // should treat null as "legacy fallback, no audit available".
    introPromptResolved: null,
    introOutput: personalizedIntro,
  };
}
