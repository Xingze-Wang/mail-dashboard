"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Plus,
  Save,
  Trash2,
  User,
  Settings,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Rep {
  id: number;
  name: string;
  sender_email: string;
  sender_name: string;
  wechat_id: string;
  active: boolean;
}

interface AssignmentConfig {
  strong_criteria: {
    min_h_index: number;
    max_school_tier: number;
    require_overseas: boolean;
  };
  assignment: {
    strong: { rep_id: number };
    normal: { rep_ids: number[]; mode: "round_robin" };
  };
}

const DEFAULT_CONFIG: AssignmentConfig = {
  strong_criteria: { min_h_index: 20, max_school_tier: 2, require_overseas: true },
  assignment: { strong: { rep_id: 1 }, normal: { rep_ids: [1], mode: "round_robin" } },
};

const EMPTY_REP = { name: "", sender_email: "", sender_name: "", wechat_id: "" };

// ─── Page ───────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [reps, setReps] = useState<Rep[]>([]);
  const [config, setConfig] = useState<AssignmentConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingRep, setSavingRep] = useState<number | "new" | null>(null);
  const [newRep, setNewRep] = useState(EMPTY_REP);
  const [showNewRep, setShowNewRep] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3000);
  };

  // ── Fetch data ──

  useEffect(() => {
    Promise.all([
      fetch("/api/sales-reps").then((r) => r.json()),
      fetch("/api/config/assignment").then((r) => r.json()),
    ])
      .then(([repsData, configData]) => {
        setReps(repsData.reps || []);
        if (configData.strong_criteria) setConfig(configData);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // ── Save assignment config ──

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      const res = await fetch("/api/config/assignment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) showFlash("Assignment config saved");
      else showFlash("Failed to save config");
    } catch {
      showFlash("Failed to save config");
    } finally {
      setSavingConfig(false);
    }
  };

  // ── Save / create rep ──

  const handleSaveRep = async (rep: Rep) => {
    setSavingRep(rep.id);
    try {
      const res = await fetch("/api/sales-reps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rep),
      });
      if (res.ok) {
        const data = await res.json();
        setReps((prev) => prev.map((r) => (r.id === rep.id ? data.rep : r)));
        showFlash(`${rep.name} updated`);
      } else {
        showFlash("Failed to save rep");
      }
    } catch {
      showFlash("Failed to save rep");
    } finally {
      setSavingRep(null);
    }
  };

  const handleCreateRep = async () => {
    if (!newRep.name || !newRep.sender_email || !newRep.sender_name || !newRep.wechat_id) {
      showFlash("All fields are required");
      return;
    }
    setSavingRep("new");
    try {
      const res = await fetch("/api/sales-reps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newRep, active: true }),
      });
      if (res.ok) {
        const data = await res.json();
        setReps((prev) => [...prev, data.rep]);
        setNewRep(EMPTY_REP);
        setShowNewRep(false);
        showFlash(`${data.rep.name} added`);
      } else {
        showFlash("Failed to create rep");
      }
    } catch {
      showFlash("Failed to create rep");
    } finally {
      setSavingRep(null);
    }
  };

  const handleToggleActive = async (rep: Rep) => {
    const updated = { ...rep, active: !rep.active };
    setSavingRep(rep.id);
    try {
      const res = await fetch("/api/sales-reps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        const data = await res.json();
        setReps((prev) => prev.map((r) => (r.id === rep.id ? data.rep : r)));
        showFlash(`${rep.name} ${updated.active ? "activated" : "deactivated"}`);
      }
    } catch {
      showFlash("Failed to update rep");
    } finally {
      setSavingRep(null);
    }
  };

  const updateRepField = (id: number, field: keyof Rep, value: string) => {
    setReps((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-500" />
      </div>
    );
  }

  return (
    <div>
      {/* Flash message */}
      {flash && (
        <div className="fixed top-4 right-4 z-50 rounded-lg bg-neutral-800 border border-neutral-700 px-4 py-2.5 text-[13px] text-white shadow-xl animate-in fade-in slide-in-from-top-2">
          {flash}
        </div>
      )}

      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-[13px] text-neutral-500 mt-0.5">
          Manage sales reps and lead assignment rules
        </p>
      </div>

      {/* ═══ Assignment Rules ═══ */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mb-6">
        <div className="flex items-center gap-2 mb-5">
          <Settings className="h-4 w-4 text-neutral-400" />
          <h2 className="text-sm font-semibold">Assignment Rules</h2>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-5">
          {/* Min h-index */}
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1.5">
              Min h-index (Strong)
            </label>
            <input
              type="number"
              value={config.strong_criteria.min_h_index}
              onChange={(e) =>
                setConfig({
                  ...config,
                  strong_criteria: {
                    ...config.strong_criteria,
                    min_h_index: parseInt(e.target.value) || 0,
                  },
                })
              }
              className="w-full rounded-lg border border-neutral-800 bg-white/[0.04] px-3 py-2 text-[13px] text-white focus:outline-none focus:border-neutral-600 transition-colors"
            />
          </div>

          {/* Max school tier */}
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1.5">
              Max School Tier (Strong)
            </label>
            <input
              type="number"
              value={config.strong_criteria.max_school_tier}
              onChange={(e) =>
                setConfig({
                  ...config,
                  strong_criteria: {
                    ...config.strong_criteria,
                    max_school_tier: parseInt(e.target.value) || 0,
                  },
                })
              }
              className="w-full rounded-lg border border-neutral-800 bg-white/[0.04] px-3 py-2 text-[13px] text-white focus:outline-none focus:border-neutral-600 transition-colors"
            />
          </div>

          {/* Require overseas */}
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1.5">
              Require Overseas
            </label>
            <select
              value={config.strong_criteria.require_overseas ? "yes" : "no"}
              onChange={(e) =>
                setConfig({
                  ...config,
                  strong_criteria: {
                    ...config.strong_criteria,
                    require_overseas: e.target.value === "yes",
                  },
                })
              }
              className="w-full rounded-lg border border-neutral-800 bg-white/[0.04] px-3 py-2 text-[13px] text-white focus:outline-none focus:border-neutral-600 transition-colors appearance-none"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23737373' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 12px center",
              }}
            >
              <option value="yes">Yes — only non-.cn emails</option>
              <option value="no">No — all emails qualify</option>
            </select>
          </div>
        </div>

        {/* Assignment mapping */}
        <div className="grid grid-cols-2 gap-4 mb-5">
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1.5">
              Strong Leads → Rep
            </label>
            <select
              value={config.assignment.strong.rep_id}
              onChange={(e) =>
                setConfig({
                  ...config,
                  assignment: {
                    ...config.assignment,
                    strong: { rep_id: parseInt(e.target.value) },
                  },
                })
              }
              className="w-full rounded-lg border border-neutral-800 bg-white/[0.04] px-3 py-2 text-[13px] text-white focus:outline-none focus:border-neutral-600 transition-colors appearance-none"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23737373' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 12px center",
              }}
            >
              {reps.filter((r) => r.active).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1.5">
              Normal Leads → Round Robin Reps
            </label>
            <div className="flex flex-wrap gap-2">
              {reps.filter((r) => r.active).map((r) => {
                const isSelected = config.assignment.normal.rep_ids.includes(r.id);
                return (
                  <button
                    key={r.id}
                    onClick={() => {
                      const ids = isSelected
                        ? config.assignment.normal.rep_ids.filter((id) => id !== r.id)
                        : [...config.assignment.normal.rep_ids, r.id];
                      if (ids.length === 0) return; // must have at least one
                      setConfig({
                        ...config,
                        assignment: {
                          ...config.assignment,
                          normal: { ...config.assignment.normal, rep_ids: ids },
                        },
                      });
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${
                      isSelected
                        ? "bg-blue-500/15 border-blue-500/30 text-blue-400"
                        : "bg-white/[0.04] border-neutral-800 text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    {r.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Preview */}
        <div className="border-t border-neutral-800/50 pt-4 flex items-center justify-between">
          <div className="flex gap-6 text-xs text-neutral-500">
            <span>
              Strong: h-index ≥ <strong className="text-neutral-400">{config.strong_criteria.min_h_index}</strong>,
              school tier ≤ <strong className="text-neutral-400">{config.strong_criteria.max_school_tier}</strong>
              {config.strong_criteria.require_overseas && ", overseas only"}
              {" → "}<strong className="text-neutral-400">{reps.find((r) => r.id === config.assignment.strong.rep_id)?.name || "?"}</strong>
            </span>
            <span>
              Normal: round-robin → <strong className="text-neutral-400">
                {config.assignment.normal.rep_ids.map((id) => reps.find((r) => r.id === id)?.name || "?").join(", ")}
              </strong>
            </span>
          </div>
          <button
            onClick={handleSaveConfig}
            disabled={savingConfig}
            className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-[7px] text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {savingConfig ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save Rules
          </button>
        </div>
      </div>

      {/* ═══ Sales Reps ═══ */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-neutral-400" />
            <h2 className="text-sm font-semibold">Sales Reps</h2>
            <span className="text-[11px] text-neutral-600 bg-white/[0.06] rounded-full px-2 py-0.5">
              {reps.filter((r) => r.active).length} active
            </span>
          </div>
          {!showNewRep && (
            <button
              onClick={() => setShowNewRep(true)}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-800 px-3 py-[6px] text-[12px] font-medium text-neutral-400 hover:text-white hover:bg-white/[0.05] transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Rep
            </button>
          )}
        </div>

        <div className="space-y-3">
          {/* Existing reps */}
          {reps.map((rep) => (
            <div
              key={rep.id}
              className={`rounded-lg border border-neutral-800/50 p-4 transition-opacity ${
                !rep.active ? "opacity-50" : ""
              }`}
            >
              <div className="grid grid-cols-4 gap-3 mb-3">
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">Name</label>
                  <input
                    type="text"
                    value={rep.name}
                    onChange={(e) => updateRepField(rep.id, "name", e.target.value)}
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white focus:outline-none focus:border-neutral-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">Sender Email</label>
                  <input
                    type="email"
                    value={rep.sender_email}
                    onChange={(e) => updateRepField(rep.id, "sender_email", e.target.value)}
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white focus:outline-none focus:border-neutral-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">Sender Name</label>
                  <input
                    type="text"
                    value={rep.sender_name}
                    onChange={(e) => updateRepField(rep.id, "sender_name", e.target.value)}
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white focus:outline-none focus:border-neutral-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">WeChat ID</label>
                  <input
                    type="text"
                    value={rep.wechat_id}
                    onChange={(e) => updateRepField(rep.id, "wechat_id", e.target.value)}
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white focus:outline-none focus:border-neutral-600"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <button
                  onClick={() => handleToggleActive(rep)}
                  className={`text-[11px] font-medium transition-colors ${
                    rep.active
                      ? "text-neutral-500 hover:text-red-400"
                      : "text-emerald-600 hover:text-emerald-400"
                  }`}
                >
                  {savingRep === rep.id ? (
                    <Loader2 className="h-3 w-3 animate-spin inline mr-1" />
                  ) : rep.active ? (
                    <Trash2 className="h-3 w-3 inline mr-1" />
                  ) : null}
                  {rep.active ? "Deactivate" : "Reactivate"}
                </button>
                <button
                  onClick={() => handleSaveRep(rep)}
                  disabled={savingRep === rep.id}
                  className="flex items-center gap-1 rounded-md bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-neutral-300 hover:bg-white/[0.1] disabled:opacity-50 transition-colors"
                >
                  {savingRep === rep.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save
                </button>
              </div>
            </div>
          ))}

          {/* New rep form */}
          {showNewRep && (
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.03] p-4">
              <p className="text-xs font-semibold text-blue-400 mb-3">New Sales Rep</p>
              <div className="grid grid-cols-4 gap-3 mb-3">
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">Name</label>
                  <input
                    type="text"
                    value={newRep.name}
                    onChange={(e) => setNewRep({ ...newRep, name: e.target.value })}
                    placeholder="Leo"
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white placeholder-neutral-700 focus:outline-none focus:border-neutral-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">Sender Email</label>
                  <input
                    type="email"
                    value={newRep.sender_email}
                    onChange={(e) => setNewRep({ ...newRep, sender_email: e.target.value })}
                    placeholder="leo@company.com"
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white placeholder-neutral-700 focus:outline-none focus:border-neutral-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">Sender Name</label>
                  <input
                    type="text"
                    value={newRep.sender_name}
                    onChange={(e) => setNewRep({ ...newRep, sender_name: e.target.value })}
                    placeholder="Leo Chen"
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white placeholder-neutral-700 focus:outline-none focus:border-neutral-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-neutral-600 mb-1">WeChat ID</label>
                  <input
                    type="text"
                    value={newRep.wechat_id}
                    onChange={(e) => setNewRep({ ...newRep, wechat_id: e.target.value })}
                    placeholder="leo_wx"
                    className="w-full rounded-md border border-neutral-800 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-white placeholder-neutral-700 focus:outline-none focus:border-neutral-600"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCreateRep}
                  disabled={savingRep === "new"}
                  className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-[6px] text-[12px] font-medium text-black hover:bg-neutral-200 disabled:opacity-50 transition-colors"
                >
                  {savingRep === "new" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  Add Rep
                </button>
                <button
                  onClick={() => { setShowNewRep(false); setNewRep(EMPTY_REP); }}
                  className="rounded-lg border border-neutral-800 px-3 py-[6px] text-[12px] text-neutral-500 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {reps.length === 0 && !showNewRep && (
            <div className="text-center py-8">
              <User className="h-8 w-8 mx-auto mb-3 text-neutral-700" />
              <p className="text-sm text-neutral-500 mb-3">No sales reps yet</p>
              <button
                onClick={() => setShowNewRep(true)}
                className="rounded-lg bg-white px-3.5 py-[7px] text-[13px] font-medium text-black hover:bg-neutral-200 transition-colors"
              >
                Add First Rep
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
