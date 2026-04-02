"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, FileText, X, Eye } from "lucide-react";
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

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<Template | null>(null);
  const [form, setForm] = useState({ name: "", subject: "", html: "" });

  const fetchTemplates = () => {
    setLoading(true);
    fetch("/api/templates")
      .then((res) => res.json())
      .then((data) => setTemplates(data.templates))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchTemplates();
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
      fetchTemplates();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this template?")) return;
    await fetch(`/api/templates?id=${id}`, { method: "DELETE" });
    fetchTemplates();
  };

  const openEditor = (template?: Template) => {
    if (template) {
      setEditing(template);
      setForm({ name: template.name, subject: template.subject, html: template.html });
    } else {
      setCreating(true);
      setForm({ name: "", subject: "", html: "" });
    }
  };

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
    setForm({ name: "", subject: "", html: "" });
  };

  const showEditor = editing || creating;

  return (
    <div className="p-8 max-w-[1200px]">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Templates</h1>
          <p className="text-sm text-neutral-400 mt-1">Reusable email templates</p>
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
          <div className="w-full max-w-2xl rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
              <h2 className="text-[15px] font-semibold text-white">
                {editing ? "Edit Template" : "New Template"}
              </h2>
              <button onClick={closeEditor} className="text-neutral-400 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Welcome Email"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">Subject</label>
                <input
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="Email subject line"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">HTML Content</label>
                <textarea
                  value={form.html}
                  onChange={(e) => setForm({ ...form, html: e.target.value })}
                  placeholder="<html>...</html>"
                  rows={14}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none resize-none font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-neutral-800 px-5 py-4">
              <button
                onClick={closeEditor}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-[13px] font-medium text-neutral-300 hover:bg-neutral-800"
              >
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
          <div className="w-full max-w-2xl rounded-xl border border-neutral-800 bg-white shadow-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-[15px] font-semibold text-black">{previewing.name} — Preview</h2>
              <button onClick={() => setPreviewing(null)} className="text-neutral-400 hover:text-black">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-6" dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewing.html) }} />
          </div>
        </div>
      )}

      {/* Template Grid */}
      {loading ? (
        <div className="text-center text-sm text-neutral-500 py-12 animate-pulse">Loading...</div>
      ) : templates.length === 0 ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-12 text-center">
          <FileText className="h-10 w-10 mx-auto mb-3 text-neutral-600" />
          <p className="text-sm text-neutral-500 mb-4">No templates yet</p>
          <button
            onClick={() => openEditor()}
            className="rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black hover:bg-neutral-200"
          >
            Create your first template
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((template) => (
            <div
              key={template.id}
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 hover:border-neutral-700 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-[14px] font-semibold text-white">{template.name}</h3>
                  <p className="text-[12px] text-neutral-500 mt-0.5">{template.subject}</p>
                </div>
              </div>

              <div className="h-[100px] rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden mb-3">
                <div
                  className="p-2 text-[10px] text-neutral-400 overflow-hidden"
                  style={{ transform: "scale(0.6)", transformOrigin: "top left", width: "166%" }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(template.html) }}
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[11px] text-neutral-500">{formatDate(template.updatedAt)}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPreviewing(template)}
                    className="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => openEditor(template)}
                    className="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    className="p-1.5 rounded-md text-neutral-400 hover:text-red-400 hover:bg-neutral-800"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
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
