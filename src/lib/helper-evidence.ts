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
  | "comparison"
  | "bar_chart"
  | "line_chart"
  | "funnel_chart";

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
  | ComparisonEvidence
  | BarChartEvidence
  | LineChartEvidence
  | FunnelChartEvidence;

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
 * Categorical bar chart. One series, N labeled bars. Use for "metric
 * X by segment Y" — top reps' wechat counts, conversion by tier, etc.
 *
 * Example LLM emission:
 *   { kind: "bar_chart", title: "Wechat by school tier",
 *     y_label: "wechat conversions", bars: [{label:"tier-1", value:18}, ...] }
 */
export interface BarChartEvidence {
  kind: "bar_chart";
  title: string;
  y_label?: string;
  bars: Array<{ label: string; value: number }>;
}

/**
 * Time-series line chart. Date-keyed points, one or more series. Use
 * for "metric over time" — daily sent counts, week-over-week reply
 * rate, etc.
 *
 * Each series shares the same x-axis (date strings). Helper should
 * pre-align points (one entry per shared x value, missing series get
 * null/0).
 */
export interface LineChartEvidence {
  kind: "line_chart";
  title: string;
  y_label?: string;
  x_label?: string;
  series: Array<{ name: string; color?: string }>;
  // points: each entry has x + one numeric value per series name
  points: Array<{ x: string } & Record<string, number | string | null>>;
}

/**
 * Sequential funnel chart. Stages get bars proportional to count.
 * Use for "X→Y→Z drop-off" — sent → delivered → clicked → wechat,
 * or any rep workflow.
 */
export interface FunnelChartEvidence {
  kind: "funnel_chart";
  title: string;
  stages: Array<{ label: string; count: number }>;
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

支持的 kind (优先选**最合适的可视化**, 不是默认 table):

文本/表格类:
- **leads** — 一组 lead_ids 支撑某个声明. data: { kind:"leads", lead_ids:[...], notes?:{lead_id: "label"} }
- **pattern** — 一个维度+桶的转化数据. data: { kind:"pattern", dimension, bucket, sent, wechat, replied, wechat_rate, reply_rate, wechat_lift, sample_lead_ids? }
- **stat** — 一个分子分母的统计. data: { kind:"stat", numerator, denominator, description, baseline? }
- **thread** — 一段过去的对话/邮件引用. data: { kind:"thread", source_ref, rep_id?, occurred_at, excerpt, outcome? }
- **comparison** — 两组以上数据并列对比 (table 形式). data: { kind:"comparison", groups: [{ label, sent, wechat, replied }, ...] }

图表类 (用户问数字时**优先**用这些, 比 table 直观):
- **bar_chart** — 单一指标的分类对比 (e.g. "wechat by school tier", "send count by rep"). data: { kind:"bar_chart", title, y_label?, bars:[{label, value}, ...] }
- **line_chart** — 时间序列, 一条或多条线 (e.g. "daily clicks over 30 days", "week-over-week reply rate"). data: { kind:"line_chart", title, y_label?, x_label?, series:[{name, color?}, ...], points:[{x:"2026-04-21", series_name_1: 12, series_name_2: 3}, ...] }
- **funnel_chart** — 顺序漏斗 (sent→delivered→clicked→wechat). data: { kind:"funnel_chart", title, stages:[{label, count}, ...] }

什么时候用图 vs table:
- "X 按 Y 分布是怎样" → bar_chart
- "X 这几周/天的趋势" → line_chart
- "我的 funnel 哪一步掉的多" / "从 X 到 Y 转化是多少" → funnel_chart
- 单条数字 → stat (不需要图)
- 一组 lead_ids → leads (不需要图)

引用规则:
- 在回答正文用 [E1] [E2] 引用对应的 evidence id.
- 没有 evidence 不能给数字 — 不确定就说 "暂时没数据" 而不是编.
- 一个 evidence 块对应一个 evidence fence; 多个块就写多个 fence.
- 只在策略性 / 数据性问题时附 evidence; 纯操作 (skip / send / 改草稿) 不需要.
- **数据型问题先想"能不能画图"**, 默认上图. 三个数 → bar_chart, 不是 stat 列三遍.
`;
