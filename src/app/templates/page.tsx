// All HTML rendering uses sanitizeHtml() which is DOMPurify-based — safe from XSS
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, FileText, X, Eye, Zap, Loader2, Sparkles } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";
import AnalysisPage from "@/app/analysis/page";

interface Template {
  id: string;
  name: string;
  subject: string;
  html: string;
  text: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_INTRO_PROMPT = `根据论文写一句个性化开头（1句话）。

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

const PIPELINE_PROMPT_NAME = "pipeline_intro_prompt";

// Wrapper page: Library / Editor / Performance tabs. Library is the
// new email_templates system (proposals, segment routing, hypotheses);
// Editor is the legacy singular-templates table (intro_prompt edits);
// Performance embeds the analysis page.
export default function TemplatesPage() {
  const [tab, setTab] = useState<"library" | "editor" | "performance">("library");
  return (
    <div>
      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid var(--border-light)" }}>
        {(["library", "editor", "performance"] as const).map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? "var(--text)" : "var(--text-tertiary)",
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid var(--blue)" : "2px solid transparent",
                marginBottom: -1,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          );
        })}
      </div>
      {tab === "library" ? <TemplateLibrary /> : tab === "editor" ? <TemplatesEditor /> : <TemplatePerformance />}
    </div>
  );
}

// ── Performance tab: per-template card grid backed by
//    /api/templates/performance. Replaces the old org-wide /analysis
//    embed — admin wanted a per-template surface where each card shows
//    the most important takeaways and clicking expands the detail.
interface TemplatePerfRow {
  id: string;
  name: string;
  rep_id: number | null;
  active: boolean;
  updated_at: string;
  sent: number;
  clicked: number;
  wechat: number;
  registered: number;
  submitted: number;
  clickRate: number;
  wechatRate: number;
  registeredRate: number;
  submittedRate: number;
  vsClickBaseline: number;
  vsWechatBaseline: number;
}
interface TemplatePerfPayload {
  windowDays: number;
  baseline: {
    totalSent: number;
    totalClicked: number;
    totalWechat: number;
    totalRegistered: number;
    totalSubmitted: number;
    clickRate: number;
    wechatRate: number;
    registeredRate: number;
    submittedRate: number;
  };
  templates: TemplatePerfRow[];
}

function TemplatePerformance() {
  const [data, setData] = useState<TemplatePerfPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [repNames, setRepNames] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/templates/performance?days=${days}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  // Resolve rep names once — performance API only returns rep_id.
  useEffect(() => {
    fetch("/api/admin/reps", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j?.reps) {
          const map: Record<number, string> = {};
          for (const r of j.reps as Array<{ id: number; name: string }>) map[r.id] = r.name;
          setRepNames(map);
        }
      })
      .catch(() => {});
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>Loading template performance…</div>;
  }
  if (error || !data) {
    return <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>Couldn&apos;t load: {error ?? "no data"}</div>;
  }

  // Sort: active templates with ≥10 sends first (sorted by submittedRate desc
  // then clickRate desc), then everything else by sent desc.
  const sorted = [...data.templates].sort((a, b) => {
    const aHot = a.active && a.sent >= 10 ? 1 : 0;
    const bHot = b.active && b.sent >= 10 ? 1 : 0;
    if (aHot !== bHot) return bHot - aHot;
    if (aHot === 1) {
      if (a.submittedRate !== b.submittedRate) return b.submittedRate - a.submittedRate;
      return b.clickRate - a.clickRate;
    }
    return b.sent - a.sent;
  });

  return (
    <div>
      {/* Top bar: window selector + baseline summary */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 16, flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Window</span>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: "4px 10px", fontSize: 12,
                background: days === d ? "var(--blue-soft)" : "transparent",
                color: days === d ? "var(--blue)" : "var(--text-secondary)",
                border: "1px solid " + (days === d ? "var(--blue)" : "var(--border)"),
                borderRadius: 6, cursor: "pointer",
              }}
            >{d}d</button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          Org baseline: {data.baseline.totalSent} sent · {(data.baseline.clickRate * 100).toFixed(1)}% click · {(data.baseline.submittedRate * 100).toFixed(1)}% submitted
        </div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", color: "var(--text-tertiary)" }}>
          No templates with traffic in the last {days} days.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
          {sorted.map((t) => (
            <TemplatePerfCard
              key={t.id}
              t={t}
              repName={t.rep_id == null ? "(global)" : repNames[t.rep_id] ?? `rep ${t.rep_id}`}
              baseline={data.baseline}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplatePerfCard({
  t, repName, baseline, expanded, onToggle,
}: {
  t: TemplatePerfRow;
  repName: string;
  baseline: TemplatePerfPayload["baseline"];
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasData = t.sent >= 5;
  const lift = (rate: number, base: number) => base > 0 ? rate / base : 0;
  const liftBadge = (rate: number, base: number) => {
    if (!hasData || base === 0) return null;
    const r = lift(rate, base);
    const pct = ((r - 1) * 100);
    if (Math.abs(pct) < 5) return null;
    return (
      <span style={{
        fontSize: 10, fontWeight: 600,
        color: pct > 0 ? "var(--green)" : "var(--red)",
        marginLeft: 4,
      }}>
        {pct > 0 ? "↑" : "↓"}{Math.abs(pct).toFixed(0)}%
      </span>
    );
  };

  return (
    <div
      className="section-card"
      style={{
        padding: 14, cursor: "pointer",
        border: "1px solid var(--border)",
        background: "var(--card)",
        transition: "all 0.15s ease",
      }}
      onClick={onToggle}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <span style={{
              fontFamily: "var(--font-heading)", fontSize: 14, fontWeight: 600,
              color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{t.name}</span>
            {!t.active && (
              <span style={{
                fontSize: 9, padding: "1px 5px", background: "var(--background-secondary)",
                color: "var(--text-tertiary)", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.04em",
              }}>off</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{repName}</div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap", marginLeft: 8 }}>
          {t.sent} sent
        </div>
      </div>

      {/* Three primary takeaways: click, wechat, submitted (the real conversion) */}
      {hasData ? (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10,
          paddingTop: 10, borderTop: "1px solid var(--border-light)",
        }}>
          <PerfTile
            label="Click"
            value={`${(t.clickRate * 100).toFixed(1)}%`}
            sub={`${t.clicked} clicks`}
            badge={liftBadge(t.clickRate, baseline.clickRate)}
          />
          <PerfTile
            label="WeChat"
            value={`${(t.wechatRate * 100).toFixed(1)}%`}
            sub={`${t.wechat} added`}
            badge={liftBadge(t.wechatRate, baseline.wechatRate)}
            valueColor={t.wechat > 0 ? "var(--green)" : undefined}
          />
          <PerfTile
            label="Submitted"
            value={`${(t.submittedRate * 100).toFixed(1)}%`}
            sub={`${t.submitted} applied`}
            valueColor={t.submitted > 0 ? "var(--green)" : undefined}
          />
        </div>
      ) : (
        <div style={{
          paddingTop: 10, borderTop: "1px solid var(--border-light)",
          fontSize: 12, color: "var(--text-tertiary)", textAlign: "center",
        }}>
          Not enough traffic yet ({t.sent}/5 minimum for rates)
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div style={{
          marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-light)",
          fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6,
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <PerfDetail label="Registered (MP)" main={`${t.registered}`} pct={`${(t.registeredRate * 100).toFixed(1)}%`} />
            <PerfDetail label="Submitted (MP)" main={`${t.submitted}`} pct={`${(t.submittedRate * 100).toFixed(1)}%`} />
            <PerfDetail label="vs org click" main={`${t.vsClickBaseline.toFixed(2)}×`} pct="lift" />
            <PerfDetail label="vs org wechat" main={`${t.vsWechatBaseline.toFixed(2)}×`} pct="lift" />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            Last updated {new Date(t.updated_at).toLocaleString()}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Link
              href={`/templates/${t.id}/inspect`}
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: 12, padding: "4px 10px", background: "var(--blue-soft)", color: "var(--blue)",
                borderRadius: 6, textDecoration: "none",
              }}
            >Inspect</Link>
            <Link
              href={`/templates/${t.id}/edit`}
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: 12, padding: "4px 10px", background: "transparent", color: "var(--text-secondary)",
                border: "1px solid var(--border)", borderRadius: 6, textDecoration: "none",
              }}
            >Edit</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function PerfTile({ label, value, sub, badge, valueColor }: {
  label: string; value: string; sub: string; badge?: React.ReactNode; valueColor?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
        {label}
      </div>
      <div style={{
        fontFamily: "var(--font-heading)", fontSize: 18, fontWeight: 600,
        color: valueColor ?? "var(--text)", letterSpacing: "-0.02em", lineHeight: 1,
      }}>
        {value}{badge}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function PerfDetail({ label, main, pct }: { label: string; main: string; pct: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{main} <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 400 }}>{pct}</span></div>
    </div>
  );
}

interface EmailTemplateRow {
  id: string;
  name: string;
  status: "active" | "approved_draft" | "proposal" | "archived";
  segment_default: string | null;
  rep_id: number | null;
  proposed_by: string | null;
  proposed_reason: string | null;
  proposed_evidence: { slot_swapped?: string; what_changed?: string; expected_pitfall?: string } | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Slot contents — used by Library card to show inline preview of
  // the swapped paragraph so admin doesn't have to open inspect to
  // see what's actually different.
  subject_format?: string;
  intro_prompt?: string;
  greeting_format?: string;
  rep_intro_format?: string;
  school_pitch_format?: string;
  cta_signoff_format?: string;
  // Pending edits joined server-side. Null = no pending. The banner
  // attribution + slot + gate verdict come from the most recent
  // pending edit; count is total pending across all slots.
  pending_edits: {
    count: number;
    latest_submitter: string | null;
    latest_slot: string | null;
    latest_verdict: string | null;
  } | null;
}

const STATUS_META: Record<EmailTemplateRow["status"], { label: string; color: string; bg: string; ring: string; description: string }> = {
  active: {
    label: "Active",
    color: "#047857",
    bg: "#ecfdf5",
    ring: "#a7f3d0",
    description: "Running production traffic",
  },
  approved_draft: {
    label: "Approved draft",
    color: "#1d4ed8",
    bg: "#eff6ff",
    ring: "#bfdbfe",
    description: "Admin approved prose, waiting on routing",
  },
  proposal: {
    label: "Proposal",
    color: "#a16207",
    bg: "#fefce8",
    ring: "#fde68a",
    description: "Congress drafted, awaiting admin decision",
  },
  archived: {
    label: "Archived",
    color: "#475569",
    bg: "#f8fafc",
    ring: "#cbd5e1",
    description: "Archived, no longer used",
  },
};

const SLOT_LABEL: Record<string, string> = {
  subject_format: "Subject",
  intro_prompt: "Intro prompt (LLM)",
  greeting_format: "Greeting",
  rep_intro_format: "Rep intro paragraph",
  school_pitch_format: "School + compute pitch",
  cta_signoff_format: "CTA + signoff",
};

const SEGMENT_BADGE: Record<string, string> = {
  cn: "🇨🇳 CN",
  overseas: "🌍 Overseas",
  edu: "🎓 EDU",
  fallback: "⚪ Fallback",
};

/**
 * Pull a short, human-readable derived title from a template name.
 * Congress proposal names look like 'proposal_h7b6e604a_school_pitch_format_20260509'
 * — that's machine-readable but admin shouldn't have to read it.
 * Strip the prefix + hash + date and present "school_pitch swap"
 * style.
 */
function humanTitle(t: EmailTemplateRow): string {
  if (t.proposed_evidence?.slot_swapped) {
    const slot = t.proposed_evidence.slot_swapped;
    const slotPretty = SLOT_LABEL[slot] ?? slot;
    if (t.proposed_by === "congress") {
      return `${slotPretty} rewrite (congress)`;
    }
    return `${slotPretty} rewrite`;
  }
  // Active/global templates: just use the name as-is
  return t.name;
}

/**
 * The actual swapped slot's text — for inline preview on Proposal
 * cards. Returns the new content, plus a sense of what changed.
 */
function getSwappedContent(t: EmailTemplateRow): { slot: string; text: string } | null {
  const slot = t.proposed_evidence?.slot_swapped;
  if (!slot) return null;
  const text = (t as unknown as Record<string, string>)[slot];
  if (!text) return null;
  return { slot, text };
}

function TemplateLibrary() {
  const [rows, setRows] = useState<EmailTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Inline-expansion state. Clicking a card toggles this; expanded
  // card renders the FULL email with parts labeled. No navigation to
  // a separate inspect page — admin asked specifically for "ONE email
  // with parts labeled" instead of parallel preview boxes.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/templates/library", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setRows(d.rows ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Group by status — admin scans by lifecycle stage, not by
  // chronological order. Each group has its own header + card stream.
  const groups: Record<EmailTemplateRow["status"], EmailTemplateRow[]> = {
    proposal: [],
    approved_draft: [],
    active: [],
    archived: [],
  };
  for (const r of rows) groups[r.status].push(r);

  const ORDER: EmailTemplateRow["status"][] = ["proposal", "approved_draft", "active", "archived"];

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Email template library</h2>
        <p style={{ fontSize: 13, color: "var(--text-tertiary)", margin: "6px 0 0", lineHeight: 1.6 }}>
          Multi-paragraph template system with segment routing + congress-drafted proposals. Click any row to inspect
          {" "}
          a mail-client-style render. Compare side-by-side in <Link href="/templates/bench" style={{ color: "var(--blue)" }}>bench</Link>
          {", "}or jump to <Link href="/congress" style={{ color: "var(--blue)" }}>congress</Link>
          {" "}to see open hypotheses.
        </p>
      </div>

      {loading && <p style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Loading…</p>}

      {!loading && rows.length === 0 && (
        <div className="section-card" style={{ padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "var(--text-tertiary)", margin: 0 }}>
            No templates yet. Wait for the congress cron to emit the first batch of proposals.
          </p>
        </div>
      )}

      {ORDER.map((status) => {
        const group = groups[status];
        if (group.length === 0) return null;
        const meta = STATUS_META[status];
        return (
          <section key={status} style={{ marginBottom: 32 }}>
            {/* Group header — large status badge + count + 1-line description */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${meta.ring}` }}>
              <span style={{
                fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
                padding: "3px 10px", borderRadius: 4,
                background: meta.bg, color: meta.color, border: `1px solid ${meta.ring}`,
              }}>
                {meta.label}
              </span>
              <span style={{ fontSize: 18, fontWeight: 600, color: meta.color }}>{group.length}</span>
              <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>· {meta.description}</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {group.map((t) => {
                const swapped = getSwappedContent(t);
                const title = humanTitle(t);
                const isExpanded = expandedId === t.id;
                return (
                  <div
                    key={t.id}
                    className="section-card"
                    style={{
                      padding: "14px 16px",
                      cursor: "default",
                      transition: "background 0.1s",
                      borderLeft: `3px solid ${meta.ring}`,
                    }}
                  >
                  {/* Header area is the click target. Toggles inline
                      expansion — same paradigm as Gmail thread. No
                      navigation to /inspect; everything renders here. */}
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : t.id)}
                    style={{
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    {/* Top row: title + segment + open arrow */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
                        {title}
                      </span>
                      {t.segment_default && (
                        <span style={{
                          fontSize: 11, padding: "2px 8px", borderRadius: 10,
                          background: "#f1f5f9", color: "#475569", fontWeight: 500,
                        }}>
                          {SEGMENT_BADGE[t.segment_default] ?? t.segment_default}
                        </span>
                      )}
                      {t.rep_id != null && (
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>rep #{t.rep_id}</span>
                      )}
                      {t.pending_edits && t.pending_edits.count > 0 && (
                        <span
                          title="Pending edits — admin needs to review"
                          style={{
                            fontSize: 10, padding: "2px 7px", borderRadius: 10,
                            background: "#fef3c7", color: "#92400e", fontWeight: 600,
                            letterSpacing: "0.02em",
                          }}
                        >
                          {t.pending_edits.count} pending
                        </span>
                      )}
                      <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--blue)" }}>
                        {isExpanded ? "Collapse ▴" : "Expand ▾"}
                      </span>
                    </div>

                    {/* Pending-edit banner — surfaces "suggested by X" so admin
                        sees who needs review without opening the card. */}
                    {t.pending_edits && t.pending_edits.count > 0 && (
                      <div style={{
                        background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6,
                        padding: "8px 10px", marginBottom: 10, fontSize: 12,
                        color: "#78350f", display: "flex", alignItems: "center", gap: 8,
                      }}>
                        <Sparkles className="h-3.5 w-3.5" style={{ flexShrink: 0 }} />
                        <span>
                          {t.pending_edits.latest_submitter ?? "Someone"} proposed change to{" "}
                          <span style={{ fontFamily: "monospace", fontWeight: 500 }}>
                            {t.pending_edits.latest_slot
                              ? (SLOT_LABEL[t.pending_edits.latest_slot] ?? t.pending_edits.latest_slot)
                              : "(unknown slot)"}
                          </span>
                          {t.pending_edits.count > 1 && (
                            <span style={{ color: "#92400e" }}> + {t.pending_edits.count - 1} more</span>
                          )}
                        </span>
                        {t.pending_edits.latest_verdict && (
                          <span style={{
                            fontSize: 10, padding: "1px 6px", borderRadius: 8,
                            background: t.pending_edits.latest_verdict === "pass"
                              ? "#d1fae5" : t.pending_edits.latest_verdict === "reject"
                                ? "#fee2e2" : "#fef3c7",
                            color: t.pending_edits.latest_verdict === "pass"
                              ? "#065f46" : t.pending_edits.latest_verdict === "reject"
                                ? "#991b1b" : "#92400e",
                            fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
                          }}>
                            gate: {t.pending_edits.latest_verdict}
                          </span>
                        )}
                        <span style={{ marginLeft: "auto", color: "#b45309", fontWeight: 600 }}>
                          Review →
                        </span>
                      </div>
                    )}

                    {/* Reason (proposal/approved_draft/archived only — active templates don't have a 'reason') */}
                    {t.proposed_reason && (
                      <p style={{
                        fontSize: 13, lineHeight: 1.65, margin: "0 0 10px",
                        color: "var(--text-secondary)", whiteSpace: "pre-wrap",
                      }}>
                        {t.proposed_reason.length > 280 ? t.proposed_reason.slice(0, 280) + "…" : t.proposed_reason}
                      </p>
                    )}

                    {/* Inline preview (collapsed state only) — short
                        teaser of the swapped slot so admin can scan the
                        list. When the card is expanded, the full
                        email below replaces this. */}
                    {!isExpanded && swapped && (
                      <div style={{
                        background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6,
                        padding: "10px 12px", fontSize: 13, lineHeight: 1.7, color: "#1f2937",
                      }}>
                        <div style={{
                          fontSize: 10, fontWeight: 600, color: "#6b7280",
                          textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6,
                        }}>
                          {SLOT_LABEL[swapped.slot] ?? swapped.slot} · new version
                        </div>
                        <div>
                          {swapped.text.length > 280 ? swapped.text.slice(0, 280) + "…" : swapped.text}
                        </div>
                      </div>
                    )}
                  </div>{/* end of click-toggle header */}

                  {/* Expanded body — ONE labeled email, no parallel
                      preview boxes. Renders the entire template as the
                      recipient would see it, with each slot's role
                      shown as a small label on the left margin. This
                      replaces the old "open inspect" navigation. */}
                  {isExpanded && (
                    <ExpandedTemplate t={t} swappedSlot={swapped?.slot ?? null} />
                  )}

                    {/* Footnote — internal name + provenance, small + tertiary. */}
                    <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-tertiary)", display: "flex", gap: 12, alignItems: "center" }}>
                      <span style={{ fontFamily: "monospace" }}>{t.name}</span>
                      {t.proposed_by && <span>via {t.proposed_by}</span>}
                      <span>· updated {new Date(t.updated_at).toLocaleDateString()}</span>
                      {(t.status === "proposal" || t.status === "approved_draft") && (
                        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                          {isExpanded && (
                            <>
                              <Link
                                href={`/congress/proposals/${t.id}/review`}
                                style={{
                                  fontSize: 11, padding: "3px 9px", borderRadius: 6,
                                  background: "#fef3c7", color: "#92400e",
                                  textDecoration: "none", border: "1px solid #fde68a",
                                }}
                                title="Review with congress's reasoning + leave feedback"
                              >
                                Discuss with congress →
                              </Link>
                              <Link
                                href={`/templates/${t.id}/inspect`}
                                style={{
                                  fontSize: 11, padding: "3px 9px", borderRadius: 6,
                                  background: "#eff6ff", color: "#1d4ed8",
                                  textDecoration: "none", border: "1px solid #bfdbfe",
                                }}
                              >
                                Approve / Activate →
                              </Link>
                            </>
                          )}
                          <InlineRejectButton templateId={t.id} templateName={t.name} />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Renders the entire template as ONE email with parts labeled — no
 * parallel preview boxes. Slot labels sit as small left-margin
 * annotations so admin sees "this is the subject, this is the
 * greeting, this is the school pitch" without losing the email's
 * actual flow. The swapped slot (the one this proposal changes) gets
 * a highlighted background so the diff is obvious without diff syntax.
 *
 * The order matches the send-time render order in template-assembler:
 *   subject → greeting → intro → rep_intro → school_pitch → cta_signoff
 */
// Slot-key label for the rendered preview gutter.
const RENDERED_SLOT_LABEL: Record<string, string> = {
  subject: "Subject",
  greeting: "Greeting",
  intro: "Intro",
  rep_intro: "Rep intro",
  school_pitch: "School pitch",
  cta_signoff: "CTA / sign-off",
};

const RENDERED_KIND_STYLE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  fixed:            { color: "#475569", bg: "transparent", border: "transparent", label: "fixed" },
  segment_selected: { color: "#0369a1", bg: "#eff6ff",    border: "#bfdbfe",     label: "segment" },
  rule_computed:    { color: "#7e22ce", bg: "#faf5ff",    border: "#e9d5ff",     label: "computed" },
  ai_generated:     { color: "#a16207", bg: "#fefce8",    border: "#fde68a",     label: "AI-generated · click" },
};

interface RenderedPart {
  slot: string;
  kind: "fixed" | "segment_selected" | "rule_computed" | "ai_generated";
  rendered: string;
  source_format: string | null;
  selection_reason: string | null;
  resolved_prompt: string | null;
}
interface RenderedSample {
  lead: { id: string; title: string; author_email: string; assigned_rep: { name: string; sender_email?: string | null } };
  rendered: { subject: string; html: string } | null;
  parts: RenderedPart[];
  intro_output?: string;
}

function ExpandedTemplate({ t, swappedSlot }: { t: EmailTemplateRow; swappedSlot: string | null }) {
  const [sample, setSample] = useState<RenderedSample | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openPart, setOpenPart] = useState<RenderedPart | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/templates/${t.id}/inspect?segment=auto&n=1`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        // The inspect API returns `renderings: [...]` — take the first.
        const first = (j.renderings ?? [])[0];
        if (!first) { setError("No golden-set lead rendered against this template"); return; }
        setSample(first as RenderedSample);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [t.id]);

  if (loading) {
    return (
      <div style={{ marginTop: 12, padding: "16px 18px", fontSize: 13, color: "#94a3b8", fontStyle: "italic", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 8 }}>
        Rendering against a golden-set lead…
      </div>
    );
  }
  if (error || !sample) {
    return (
      <div style={{ marginTop: 12, padding: "16px 18px", fontSize: 13, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8 }}>
        Couldn&apos;t render preview: {error ?? "unknown"}
      </div>
    );
  }

  // Map the lead's assigned rep slot order to the standard order
  const orderedSlots = ["subject", "greeting", "intro", "rep_intro", "school_pitch", "cta_signoff"];
  const partBySlot = new Map<string, RenderedPart>();
  for (const p of sample.parts) partBySlot.set(p.slot, p);

  return (
    <div style={{ marginTop: 12 }}>
      {/* Mail-client style header so the rep sees this as a REAL email. */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 14,
        color: "#1f2937",
      }}>
        {/* Envelope */}
        <div style={{ background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "10px 16px", fontSize: 12, lineHeight: 1.6 }}>
          <div><span style={{ color: "#64748b", display: "inline-block", width: 36 }}>From</span> {sample.lead.assigned_rep.name}{sample.lead.assigned_rep.sender_email ? ` <${sample.lead.assigned_rep.sender_email}>` : ""}</div>
          <div><span style={{ color: "#64748b", display: "inline-block", width: 36 }}>To</span> <span style={{ fontFamily: "monospace" }}>{sample.lead.author_email}</span></div>
          <div style={{ color: "#94a3b8", marginTop: 2 }}>
            Sample paper: {sample.lead.title.slice(0, 80)}
          </div>
        </div>

        {/* Body: one labeled email, each slot a row */}
        <div style={{ padding: "16px 18px", lineHeight: 1.75 }}>
          {orderedSlots.map((slot) => {
            const part = partBySlot.get(slot);
            if (!part) return null;
            const isSwapped = swappedSlot === `${slot}_format` || swappedSlot === slot ||
                              swappedSlot === "intro_prompt" && slot === "intro";
            const kindStyle = RENDERED_KIND_STYLE[part.kind];
            return (
              <div
                key={slot}
                onClick={() => setOpenPart(part)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "110px 1fr",
                  gap: 14,
                  marginBottom: slot === "subject" ? 18 : 12,
                  alignItems: "start",
                  cursor: "pointer",
                  padding: "4px 4px",
                  marginLeft: -4,
                  marginRight: -4,
                  borderRadius: 4,
                  transition: "background 0.1s",
                }}
              >
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: isSwapped ? "#a16207" : kindStyle.color,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  paddingTop: 4,
                  textAlign: "right",
                }}>
                  {RENDERED_SLOT_LABEL[slot] ?? slot}
                  {isSwapped && <div style={{ fontWeight: 600, marginTop: 2, color: "#a16207" }}>· changed here</div>}
                  <div style={{ fontWeight: 500, marginTop: 2, opacity: 0.65, fontSize: 9 }}>{kindStyle.label}</div>
                </div>
                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    padding: (isSwapped || part.kind === "ai_generated") ? "8px 10px" : "0",
                    background: isSwapped ? "#fefce8" : kindStyle.bg,
                    borderLeft: isSwapped ? "3px solid #fde68a" : (part.kind === "ai_generated" ? `3px solid ${kindStyle.border}` : "none"),
                    borderRadius: (isSwapped || part.kind === "ai_generated") ? 4 : 0,
                    fontWeight: slot === "subject" ? 600 : 400,
                    fontSize: slot === "subject" ? 15 : 14,
                  }}
                  // sanitizeHtml is DOMPurify-based (see src/lib/sanitize.ts)
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(part.rendered) }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Slide-in detail for AI-generated parts: prompt + source format
          + selection reason. Clicking any part opens this; clicking
          backdrop closes. */}
      {openPart && (
        <div
          onClick={() => setOpenPart(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", justifyContent: "flex-end" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "white", width: "min(560px, 100%)", height: "100%", overflowY: "auto", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)" }}
          >
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {RENDERED_SLOT_LABEL[openPart.slot] ?? openPart.slot} ·
                <span style={{ marginLeft: 6, fontSize: 11, color: RENDERED_KIND_STYLE[openPart.kind].color, fontWeight: 500 }}>
                  {RENDERED_KIND_STYLE[openPart.kind].label}
                </span>
              </div>
              <button onClick={() => setOpenPart(null)} style={{ background: "none", border: "none", fontSize: 18, color: "#94a3b8", cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 6 }}>Rendered (in this preview)</div>
                <div
                  style={{ fontSize: 13, padding: "10px 12px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, whiteSpace: "pre-wrap" }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(openPart.rendered) }}
                />
              </div>
              {openPart.source_format && openPart.kind !== "ai_generated" && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 6 }}>Source format (template)</div>
                  <pre style={{ fontSize: 11, fontFamily: "monospace", padding: "10px 12px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, whiteSpace: "pre-wrap", overflowX: "auto" }}>{openPart.source_format}</pre>
                </div>
              )}
              {openPart.kind === "ai_generated" && openPart.resolved_prompt && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#a16207", marginBottom: 6 }}>Prompt fed to LLM (after placeholder resolution)</div>
                  <pre style={{ fontSize: 11, fontFamily: "monospace", padding: "10px 12px", background: "#fefce8", border: "1px solid #fde68a", borderRadius: 6, whiteSpace: "pre-wrap", overflowX: "auto" }}>{openPart.resolved_prompt}</pre>
                </div>
              )}
              {openPart.kind === "ai_generated" && sample.intro_output && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#a16207", marginBottom: 6 }}>Raw LLM output (pre-HTML-escape)</div>
                  <pre style={{ fontSize: 11, fontFamily: "monospace", padding: "10px 12px", background: "#fefce8", border: "1px solid #fde68a", borderRadius: 6, whiteSpace: "pre-wrap", overflowX: "auto" }}>{sample.intro_output}</pre>
                </div>
              )}
              {openPart.selection_reason && openPart.kind !== "ai_generated" && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 6 }}>Why this slot</div>
                  <div style={{ fontSize: 12, color: "#475569", padding: "8px 10px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6 }}>{openPart.selection_reason}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline reject button for the library list. Opens a small modal
 * that captures the admin's reason (≥10 chars) and calls
 * /api/templates/[id]/reject. The reason becomes evidence in next
 * Monday's congress (mig 076 + congress-runners.ts evidence pack).
 *
 * Uses stopPropagation so the surrounding <Link> doesn't navigate
 * when the button is clicked.
 */
function InlineRejectButton({ templateId, templateName }: { templateId: string; templateName: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = reason.trim();
    if (r.length < 10) {
      alert("Reason needs to be ≥10 chars. This becomes evidence the next congress reads, so be specific.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/${templateId}/reject`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: r }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Failed: ${j.error ?? res.status}`);
        return;
      }
      setOpen(false);
      setReason("");
      // Reload the page so the rejected row falls out of the proposal group.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        style={{
          fontSize: 11, padding: "2px 8px", borderRadius: 4,
          background: "white", color: "#b91c1c", border: "1px solid #fca5a5",
          cursor: "pointer", fontWeight: 500,
        }}
      >
        Reject
      </button>
      {open && (
        <div
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) setOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
            zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            style={{
              background: "white", borderRadius: 8, padding: 20, maxWidth: 520, width: "100%",
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 6px" }}>
              Reject proposal
            </h3>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4, fontFamily: "monospace" }}>
              {templateName}
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55, margin: "0 0 10px" }}>
              Your reason goes into the next congress&rsquo;s evidence pack — the synthesizer sees &ldquo;proposed X, admin rejected with Y&rdquo; and avoids re-proposing the same kind. Be specific.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why reject? (≥10 chars)"
              rows={4}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%", padding: 8, fontSize: 13, borderRadius: 4,
                border: "1px solid #d4d4d8", boxSizing: "border-box", fontFamily: "inherit",
              }}
            />
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>
              {reason.trim().length} / 1500 chars
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); setReason(""); }}
                disabled={busy}
                style={{
                  fontSize: 13, padding: "6px 12px", borderRadius: 4,
                  background: "white", color: "var(--text-primary)",
                  border: "1px solid #d4d4d8", cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={(e) => void submit(e)}
                disabled={busy || reason.trim().length < 10}
                style={{
                  fontSize: 13, padding: "6px 12px", borderRadius: 4,
                  background: "#dc2626", color: "white", border: "none",
                  cursor: busy ? "wait" : "pointer", opacity: busy || reason.trim().length < 10 ? 0.5 : 1,
                }}
              >
                {busy ? "Rejecting..." : "Reject + archive"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TemplatesEditor() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<Template | null>(null);
  const [form, setForm] = useState({ name: "", subject: "", html: "" });
  const [testing, setTesting] = useState(false);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testPaper, setTestPaper] = useState<string | null>(null);

  const fetchTemplates = () => {
    setLoading(true);
    fetch("/api/templates")
      .then((res) => res.json())
      .then((data) => setTemplates(data.templates))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  const seedDefaultPrompt = async (existing: Template[]) => {
    const hasPrompt = existing.some((t) => t.name === PIPELINE_PROMPT_NAME);
    if (!hasPrompt) {
      await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: PIPELINE_PROMPT_NAME,
          subject: "Pipeline Intro Prompt — edit to customize AI-generated email intros",
          html: DEFAULT_INTRO_PROMPT,
        }),
      });
      fetchTemplates();
    }
  };

  useEffect(() => {
    fetch("/api/templates")
      .then((res) => res.json())
      .then((data) => {
        setTemplates(data.templates);
        setLoading(false);
        seedDefaultPrompt(data.templates);
      })
      .catch((e) => { console.error(e); setLoading(false); });
  }, []);

  const handleSave = async () => {
    const method = editing ? "PUT" : "POST";
    const body = editing ? { id: editing.id, ...form } : form;
    const res = await fetch("/api/templates", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setEditing(null);
      setCreating(false);
      setForm({ name: "", subject: "", html: "" });
      setTestOutput(null);
      fetchTemplates();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this template?")) return;
    await fetch(`/api/templates?id=${id}`, { method: "DELETE" });
    fetchTemplates();
  };

  const handleTest = async () => {
    setTesting(true);
    setTestOutput(null);
    setTestPaper(null);
    try {
      const res = await fetch("/api/templates/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: form.html }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestOutput(data.output);
        setTestPaper(data.samplePaper?.title || null);
      } else {
        setTestOutput(`Error: ${data.error}`);
      }
    } catch {
      setTestOutput("Test failed");
    } finally {
      setTesting(false);
    }
  };

  const openEditor = (template?: Template) => {
    if (template) {
      setEditing(template);
      setForm({ name: template.name, subject: template.subject, html: template.html });
    } else {
      setCreating(true);
      setForm({ name: "", subject: "", html: "" });
    }
    setTestOutput(null);
    setTestPaper(null);
  };

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
    setForm({ name: "", subject: "", html: "" });
    setTestOutput(null);
  };

  const isPromptTemplate = (name: string) => name === PIPELINE_PROMPT_NAME;
  const showEditor = editing || creating;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Templates</h1>
          <span className="lead-count">Email & AI prompts</span>
        </div>
        <button onClick={() => openEditor()} className="btn btn-primary">
          <Plus />
          New Template
        </button>
      </div>

      {/* Editor Modal */}
      {showEditor && (
        <div className="modal-backdrop" onClick={closeEditor}>
          <div
            className="modal-card"
            style={{ width: "100%", maxWidth: 820 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border-light)", padding: "18px 24px" }}>
              <div>
                <h2 style={{ fontFamily: "var(--font-heading)", fontSize: 18, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" }}>
                  {editing ? "Edit Template" : "New Template"}
                </h2>
                <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
                  Edit name, description, and {isPromptTemplate(form.name) ? "prompt content" : "HTML body"}.
                </p>
              </div>
              <button onClick={closeEditor} className="btn-ghost" aria-label="Close" style={{ borderRadius: 6 }}>
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>

            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
                    Name
                  </label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. pipeline_intro_prompt"
                    className="search-input"
                    style={{ width: "100%", paddingLeft: 12, backgroundImage: "none" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
                    Description
                  </label>
                  <input
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    placeholder="What this template does"
                    className="search-input"
                    style={{ width: "100%", paddingLeft: 12, backgroundImage: "none" }}
                  />
                </div>
              </div>

              {isPromptTemplate(form.name) && (
                <div style={{ borderRadius: 8, background: "var(--blue-bg)", border: "1px solid #BFDBFE", padding: "8px 12px" }}>
                  <p style={{ fontSize: 11, color: "var(--blue)" }}>
                    Pipeline prompt template. Use{" "}
                    <code style={{ background: "rgba(37,99,235,0.12)", padding: "1px 4px", borderRadius: 4 }}>
                      {"{{title}}"}
                    </code>{" "}
                    and{" "}
                    <code style={{ background: "rgba(37,99,235,0.12)", padding: "1px 4px", borderRadius: 4 }}>
                      {"{{abstract}}"}
                    </code>{" "}
                    as placeholders.
                  </p>
                </div>
              )}

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
                  {isPromptTemplate(form.name) ? "Prompt" : "HTML Content"}
                </label>
                <textarea
                  value={form.html}
                  onChange={(e) => setForm({ ...form, html: e.target.value })}
                  rows={16}
                  style={{
                    width: "100%",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    padding: "10px 12px",
                    fontSize: 13,
                    color: "var(--text)",
                    outline: "none",
                    resize: "none",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    lineHeight: 1.6,
                  }}
                />
              </div>

              {/* Test Output for prompt templates */}
              {isPromptTemplate(form.name) && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)" }}>Test Output</label>
                    <button onClick={handleTest} disabled={testing || !form.html} className="btn">
                      {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap />}
                      {testing ? "Running..." : "Test with sample paper"}
                    </button>
                  </div>
                  {testPaper && (
                    <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8 }}>Sample: {testPaper}</p>
                  )}
                  <div style={{
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    padding: "12px 16px",
                    minHeight: 60,
                  }}>
                    {testOutput ? (
                      <p style={{
                        fontSize: 13, lineHeight: 1.6,
                        color: testOutput.startsWith("Error") ? "var(--coral)" : "var(--text)",
                      }}>
                        {testOutput}
                      </p>
                    ) : (
                      <p style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                        Click &quot;Test with sample paper&quot; to preview
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, borderTop: "1px solid var(--border-light)", padding: "16px 20px" }}>
              <button onClick={closeEditor} className="btn">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!form.name || !form.subject || !form.html}
                className="btn btn-primary"
              >
                {editing ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewing && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(10,10,10,0.4)", backdropFilter: "blur(6px)",
          }}
        >
          <div
            style={{
              width: "100%", maxWidth: 672, maxHeight: "90vh", overflow: "auto",
              borderRadius: "var(--radius)", border: "1px solid var(--border)",
              background: "var(--card)", boxShadow: "var(--shadow-md)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border-light)", padding: "16px 20px" }}>
              <h2 style={{ fontFamily: "var(--font-heading)", fontSize: 16, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" }}>
                {previewing.name}
              </h2>
              <button onClick={() => setPreviewing(null)} className="btn" style={{ background: "transparent", border: "none", padding: 4 }}>
                <X />
              </button>
            </div>
            {isPromptTemplate(previewing.name) ? (
              <pre style={{ padding: 20, fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: 1.6 }}>
                {previewing.html}
              </pre>
            ) : (
              <div className="p-6 bg-white rounded-b-xl" dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewing.html) }} />
            )}
          </div>
        </div>
      )}

      {/* Template List */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 84 }} />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="section-card" style={{ padding: 48, textAlign: "center" }}>
          <FileText style={{ width: 40, height: 40, color: "var(--text-tertiary)", margin: "0 auto 12px" }} />
          <p style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Loading default templates...</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {templates.map((template) => (
            <div key={template.id} className="lead-card" style={{ padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 16, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" }}>
                      {template.name}
                    </h3>
                    {isPromptTemplate(template.name) && (
                      <span className="badge-status new" style={{ padding: "2px 10px" }}>
                        AI Prompt
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{template.subject}</p>
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, display: "inline-block" }}>
                    Updated {formatDate(template.updatedAt)}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginLeft: 16 }}>
                  <button
                    onClick={() => setPreviewing(template)}
                    className="btn"
                    style={{ background: "transparent", border: "none", padding: 8 }}
                    title="Preview"
                  >
                    <Eye />
                  </button>
                  <button
                    onClick={() => openEditor(template)}
                    className="btn"
                    style={{ background: "transparent", border: "none", padding: 8 }}
                    title="Edit"
                  >
                    <Pencil />
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    className="btn"
                    style={{ background: "transparent", border: "none", padding: 8, color: "var(--coral)" }}
                    title="Delete"
                  >
                    <Trash2 />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
