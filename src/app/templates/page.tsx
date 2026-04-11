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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Templates</h1>
          <p className="text-sm text-neutral-400 mt-1">Email templates and AI prompt templates</p>
        </div>
        <button
          onClick={() => openEditor()}
          className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black hover:bg-neutral-200 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Template
        </button>
      </div>

      {/* Editor Modal */}
      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-3xl rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
              <h2 className="text-[15px] font-semibold text-white">
                {editing ? "Edit Template" : "New Template"}
              </h2>
              <button onClick={closeEditor} className="text-neutral-400 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">Name</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. pipeline_intro_prompt"
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">Description</label>
                  <input
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    placeholder="What this template does"
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                  />
                </div>
              </div>

              {isPromptTemplate(form.name) && (
                <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2">
                  <p className="text-[11px] text-blue-400">
                    Pipeline prompt template. Use <code className="bg-blue-500/20 px-1 rounded">{"{{title}}"}</code> and <code className="bg-blue-500/20 px-1 rounded">{"{{abstract}}"}</code> as placeholders.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">
                  {isPromptTemplate(form.name) ? "Prompt" : "HTML Content"}
                </label>
                <textarea
                  value={form.html}
                  onChange={(e) => setForm({ ...form, html: e.target.value })}
                  rows={16}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none resize-none font-mono leading-relaxed"
                />
              </div>

              {/* Test Output for prompt templates */}
              {isPromptTemplate(form.name) && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[12px] font-medium text-neutral-400">Test Output</label>
                    <button
                      onClick={handleTest}
                      disabled={testing || !form.html}
                      className="flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-1 text-[11px] text-neutral-300 hover:text-white hover:bg-neutral-800 disabled:opacity-40 transition-colors"
                    >
                      {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                      {testing ? "Running..." : "Test with sample paper"}
                    </button>
                  </div>
                  {testPaper && (
                    <p className="text-[11px] text-neutral-500 mb-2">Sample: {testPaper}</p>
                  )}
                  <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-3 min-h-[60px]">
                    {testOutput ? (
                      <p className={`text-[13px] leading-relaxed ${testOutput.startsWith("Error") ? "text-red-400" : "text-neutral-300"}`}>
                        {testOutput}
                      </p>
                    ) : (
                      <p className="text-[12px] text-neutral-600 italic">
                        Click &quot;Test with sample paper&quot; to preview
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 border-t border-neutral-800 px-5 py-4">
              <button onClick={closeEditor} className="rounded-lg border border-neutral-700 px-4 py-2 text-[13px] font-medium text-neutral-300 hover:bg-neutral-800">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!form.name || !form.subject || !form.html}
                className="rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {editing ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
              <h2 className="text-[15px] font-semibold text-white">{previewing.name}</h2>
              <button onClick={() => setPreviewing(null)} className="text-neutral-400 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            {isPromptTemplate(previewing.name) ? (
              <pre className="p-5 text-[12px] text-neutral-300 whitespace-pre-wrap font-mono leading-relaxed">
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
        <div className="text-center text-sm text-neutral-500 py-12 animate-pulse">Loading...</div>
      ) : templates.length === 0 ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-12 text-center">
          <FileText className="h-10 w-10 mx-auto mb-3 text-neutral-600" />
          <p className="text-sm text-neutral-500">Loading default templates...</p>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((template) => (
            <div key={template.id} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 hover:border-neutral-700 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-[14px] font-semibold text-white">{template.name}</h3>
                    {isPromptTemplate(template.name) && (
                      <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-400">AI Prompt</span>
                    )}
                  </div>
                  <p className="text-[12px] text-neutral-500">{template.subject}</p>
                  <span className="text-[11px] text-neutral-600 mt-1 inline-block">Updated {formatDate(template.updatedAt)}</span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0 ml-4">
                  <button onClick={() => setPreviewing(template)} className="p-2 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors" title="Preview">
                    <Eye className="h-4 w-4" />
                  </button>
                  <button onClick={() => openEditor(template)} className="p-2 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors" title="Edit">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleDelete(template.id)} className="p-2 rounded-md text-neutral-400 hover:text-red-400 hover:bg-neutral-800 transition-colors" title="Delete">
                    <Trash2 className="h-4 w-4" />
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
