// HelperEvidence — structured "show the data" payload that travels
// alongside a helper answer.
//
// Why this exists: the helper used to make claims like "你这周转化降了"
// without any way for the rep to verify. With evidence, every numeric
// claim or recommendation is one click away from the underlying rows.
// That's the trust layer.
//
// The LLM emits evidence in its response as fenced ```evidence blocks
// holding JSON. The route extracts them, sends them as a separate
// `evidence: HelperEvidence[]` field on the API response, and strips
// them from the visible answer text. The UI renders each evidence as
// an expandable card under the assistant bubble.

export type EvidenceKind =
  | "leads"
  | "pattern"
  | "stat"
  | "thread"
  | "comparison";

export interface HelperEvidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  data: EvidenceData;
}

export type EvidenceData =
  | LeadsEvidence
  | PatternEvidence
  | StatEvidence
  | ThreadEvidence
  | ComparisonEvidence;

export interface LeadsEvidence {
  kind: "leads";
  lead_ids: string[];
  notes?: Record<string, string>;
}

export interface PatternEvidence {
  kind: "pattern";
  dimension: string;
  bucket: string;
  sent: number;
  wechat: number;
  replied: number;
  wechat_rate: number;
  reply_rate: number;
  wechat_lift: number;
  sample_lead_ids?: string[];
}

export interface StatEvidence {
  kind: "stat";
  numerator: number;
  denominator: number;
  description: string;
  baseline?: number;
}

export interface ThreadEvidence {
  kind: "thread";
  source_ref: string;
  rep_id?: number | null;
  occurred_at: string;
  excerpt: string;
  outcome?: string;
}

export interface ComparisonEvidence {
  kind: "comparison";
  groups: Array<{
    label: string;
    sent: number;
    wechat: number;
    replied: number;
  }>;
}

/**
 * Extract evidence blocks from a model response. Returns the
 * stripped text + parsed evidences (those that pass shape validation).
 */
export function extractEvidence(text: string): { cleaned: string; evidence: HelperEvidence[] } {
  const re = /```evidence\s*\n([\s\S]*?)\n```/g;
  const evidence: HelperEvidence[] = [];
  let match: RegExpExecArray | null;
  let counter = 0;
  while ((match = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Partial<HelperEvidence>;
      if (!parsed || typeof parsed !== "object") continue;
      if (typeof parsed.kind !== "string") continue;
      if (!parsed.data || typeof parsed.data !== "object") continue;
      counter++;
      const id = (typeof parsed.id === "string" && parsed.id.length > 0) ? parsed.id : `E${counter}`;
      const label = typeof parsed.label === "string" ? parsed.label : `${parsed.kind}`;
      const data = parsed.data as { kind?: string };
      if (data.kind !== parsed.kind) continue;
      evidence.push({ id, kind: parsed.kind as EvidenceKind, label, data: parsed.data as EvidenceData });
    } catch {
      // bad JSON — drop
    }
  }
  const cleaned = text
    .replace(/```evidence\s*\n[\s\S]*?\n```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleaned, evidence };
}

/** System-prompt fragment describing the evidence protocol. */
export const EVIDENCE_PROMPT_EXAMPLES = `## 证据系统 (重要 — "Show the data" 硬要求)

任何数字声明、对比、推荐都必须附带 evidence 块. UI 会渲染成可展开卡片, rep 一键看到底层数据.

格式 (放在回答末尾, 一个或多个):

\`\`\`evidence
{"id":"E1","kind":"pattern","label":".cn 作者转化率","data":{"kind":"pattern","dimension":"location","bucket":"CN","sent":231,"wechat":19,"replied":0,"wechat_rate":0.082,"reply_rate":0,"wechat_lift":0.63,"sample_lead_ids":["abc123","def456"]}}
\`\`\`

支持的 kind:
- **leads** — 一组 lead_ids 支撑某个声明. data: { kind:"leads", lead_ids:[...], notes?:{lead_id: "label"} }
- **pattern** — 一个维度+桶的转化数据. data: { kind:"pattern", dimension, bucket, sent, wechat, replied, wechat_rate, reply_rate, wechat_lift, sample_lead_ids? }
- **stat** — 一个分子分母的统计. data: { kind:"stat", numerator, denominator, description, baseline? }
- **thread** — 一段过去的对话/邮件引用. data: { kind:"thread", source_ref, rep_id?, occurred_at, excerpt, outcome? }
- **comparison** — 两组以上数据并列对比. data: { kind:"comparison", groups: [{ label, sent, wechat, replied }, ...] }

引用规则:
- 在回答正文用 [E1] [E2] 引用对应的 evidence id.
- 没有 evidence 不能给数字 — 不确定就说 "暂时没数据" 而不是编.
- 一个 evidence 块对应一个 evidence fence; 多个块就写多个 fence.
- 只在策略性 / 数据性问题时附 evidence; 纯操作 (skip / send / 改草稿) 不需要.
`;
