// All HTML rendering uses sanitizeHtml() which is DOMPurify-based — safe from XSS
"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, FileText, X, Eye, Zap, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";

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

export default function TemplatesPage() {
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
