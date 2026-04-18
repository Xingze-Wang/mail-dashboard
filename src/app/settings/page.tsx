"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Plus,
  Save,
  Trash2,
  User,
  Settings,
  Crown,
  Globe,
  MapPin,
} from "lucide-react";
import { paletteFor } from "@/app/pipeline/repColors";

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
    min_citation: number;
    max_school_tier: number;
  };
  assignment: {
    strong: { rep_id: number };
    overseas: { rep_id: number };
    domestic: { rep_id: number };
  };
}

const DEFAULT_CONFIG: AssignmentConfig = {
  strong_criteria: { min_citation: 2000, max_school_tier: 2 },
  assignment: {
    strong: { rep_id: 1 },
    overseas: { rep_id: 3 },
    domestic: { rep_id: 2 },
  },
};

const EMPTY_REP = { name: "", sender_email: "", sender_name: "", wechat_id: "" };

// ─── Page ───────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [reps, setReps] = useState<Rep[]>([]);
  const [config, setConfig] = useState<AssignmentConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [reassigning, setReassigning] = useState(false);
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
        if (configData?.strong_criteria && configData?.assignment) {
          // The /api/config/assignment GET handler normalizes legacy shapes
          // forward to {strong, overseas, domestic}, so we can trust the result.
          setConfig({
            strong_criteria: {
              min_citation:
                configData.strong_criteria.min_citation ??
                DEFAULT_CONFIG.strong_criteria.min_citation,
              max_school_tier:
                configData.strong_criteria.max_school_tier ??
                DEFAULT_CONFIG.strong_criteria.max_school_tier,
            },
            assignment: {
              strong: { rep_id: configData.assignment.strong?.rep_id ?? DEFAULT_CONFIG.assignment.strong.rep_id },
              overseas: { rep_id: configData.assignment.overseas?.rep_id ?? DEFAULT_CONFIG.assignment.overseas.rep_id },
              domestic: { rep_id: configData.assignment.domestic?.rep_id ?? DEFAULT_CONFIG.assignment.domestic.rep_id },
            },
          });
        }
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

  // ── Re-assign ALL existing leads ──

  const handleReassignAll = async () => {
    setReassigning(true);
    try {
      const res = await fetch("/api/config/assignment", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        showFlash(
          `Re-assigned ${data.reassigned} of ${data.scanned} leads (${data.retiered} re-tiered)`,
        );
      } else {
        const data = await res.json().catch(() => ({}));
        showFlash(`Re-assign failed: ${data.error ?? res.status}`);
      }
    } catch {
      showFlash("Re-assign failed");
    } finally {
      setReassigning(false);
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "96px 0" }}>
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--text-tertiary)" }} />
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--card)",
    padding: "8px 12px",
    fontSize: 13,
    color: "var(--text)",
    outline: "none",
    fontFamily: "var(--font-body)",
  };

  const activeReps = reps.filter((r) => r.active);
  const repName = (id: number) => reps.find((r) => r.id === id)?.name ?? "?";

  return (
    <div>
      {/* Flash message */}
      {flash && (
        <div
          style={{
            position: "fixed", top: 16, right: 16, zIndex: 50,
            borderRadius: "var(--radius-sm)",
            background: "var(--text)", color: "white",
            border: "1px solid var(--text)",
            padding: "10px 16px", fontSize: 13,
            boxShadow: "var(--shadow-md)",
          }}
          className="animate-slide-in"
        >
          {flash}
        </div>
      )}

      {/* Page Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Settings</h1>
          <span className="lead-count">Reps & assignment</span>
        </div>
      </div>

      {/* ═══ Assignment Rules ═══ */}
      <div id="assignment" className="section-card" style={{ marginBottom: 24, scrollMarginTop: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Settings style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
          <h3 style={{ marginBottom: 0 }}>Assignment Rules</h3>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 20 }}>
          Strong if <strong>citation_count &gt; threshold</strong> OR{" "}
          <strong>school_tier ≤ threshold</strong>. Routing is then a flat 3-way:
          strong → strong rep, normal+overseas → overseas rep, normal+domestic → domestic rep.
        </p>

        {/* Strong criteria */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 20 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Min citation_count for Strong
            </label>
            <input
              type="number"
              value={config.strong_criteria.min_citation}
              onChange={(e) =>
                setConfig({
                  ...config,
                  strong_criteria: {
                    ...config.strong_criteria,
                    min_citation: parseInt(e.target.value) || 0,
                  },
                })
              }
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Max school_tier for Strong
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
              style={inputStyle}
            />
          </div>
        </div>

        {/* Routing — 3 selects (strong / overseas / domestic) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
          {([
            { key: "strong", label: "Strong → rep", icon: Crown, hint: "Tier=Strong" },
            { key: "overseas", label: "Normal · overseas → rep", icon: Globe, hint: "domain ≠ .cn" },
            { key: "domestic", label: "Normal · domestic → rep", icon: MapPin, hint: "domain = .cn" },
          ] as const).map((row) => {
            const selectedId = config.assignment[row.key].rep_id;
            const palette = paletteFor(repName(selectedId));
            const Icon = row.icon;
            return (
              <div
                key={row.key}
                style={{
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-light)",
                  background: "var(--card)",
                  padding: 12,
                  borderLeft: `3px solid ${palette.solid}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <Icon style={{ width: 13, height: 13, color: palette.color }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {row.label}
                  </span>
                </div>
                <select
                  className="filter-select"
                  value={selectedId}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      assignment: {
                        ...config.assignment,
                        [row.key]: { rep_id: parseInt(e.target.value) },
                      },
                    })
                  }
                  style={{ width: "100%", padding: "8px 28px 8px 12px", fontSize: 13 }}
                >
                  {activeReps.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>{row.hint}</div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, color: "var(--text-tertiary)" }}>
            <span>
              Strong → <strong style={{ color: paletteFor(repName(config.assignment.strong.rep_id)).color }}>{repName(config.assignment.strong.rep_id)}</strong>
            </span>
            <span>
              Overseas → <strong style={{ color: paletteFor(repName(config.assignment.overseas.rep_id)).color }}>{repName(config.assignment.overseas.rep_id)}</strong>
            </span>
            <span>
              Domestic → <strong style={{ color: paletteFor(repName(config.assignment.domestic.rep_id)).color }}>{repName(config.assignment.domestic.rep_id)}</strong>
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleReassignAll} disabled={reassigning} className="btn">
              {reassigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Re-assign all leads
            </button>
            <button onClick={handleSaveConfig} disabled={savingConfig} className="btn btn-primary">
              {savingConfig ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save />}
              Save Rules
            </button>
          </div>
        </div>
      </div>

      {/* ═══ Sales Reps ═══ */}
      <div className="section-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <User style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
            <h3 style={{ marginBottom: 0 }}>Sales Reps</h3>
            <span className="lead-count">{activeReps.length} active</span>
          </div>
          {!showNewRep && (
            <button onClick={() => setShowNewRep(true)} className="btn">
              <Plus />
              Add Rep
            </button>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Existing reps */}
          {reps.map((rep) => {
            const palette = paletteFor(rep.name);
            return (
              <div
                key={rep.id}
                style={{
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  borderLeft: `3px solid ${palette.solid}`,
                  background: "var(--card)",
                  padding: 16,
                  opacity: rep.active ? 1 : 0.55,
                  transition: "opacity 0.15s ease",
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      Name
                    </label>
                    <input
                      type="text"
                      value={rep.name}
                      onChange={(e) => updateRepField(rep.id, "name", e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      Sender Email
                    </label>
                    <input
                      type="email"
                      value={rep.sender_email}
                      onChange={(e) => updateRepField(rep.id, "sender_email", e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      Sender Name
                    </label>
                    <input
                      type="text"
                      value={rep.sender_name}
                      onChange={(e) => updateRepField(rep.id, "sender_name", e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      WeChat ID
                    </label>
                    <input
                      type="text"
                      value={rep.wechat_id}
                      onChange={(e) => updateRepField(rep.id, "wechat_id", e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <button
                    onClick={() => handleToggleActive(rep)}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: rep.active ? "var(--text-tertiary)" : "var(--green)",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {savingRep === rep.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : rep.active ? (
                      <Trash2 style={{ width: 12, height: 12 }} />
                    ) : null}
                    {rep.active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button onClick={() => handleSaveRep(rep)} disabled={savingRep === rep.id} className="btn">
                    {savingRep === rep.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save />}
                    Save
                  </button>
                </div>
              </div>
            );
          })}

          {/* New rep form */}
          {showNewRep && (
            <div
              style={{
                borderRadius: "var(--radius)",
                border: "1px solid #BFDBFE",
                background: "var(--blue-bg)",
                padding: 16,
              }}
            >
              <p style={{ fontSize: 12, fontWeight: 600, color: "var(--blue)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                New Sales Rep
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Name
                  </label>
                  <input
                    type="text"
                    value={newRep.name}
                    onChange={(e) => setNewRep({ ...newRep, name: e.target.value })}
                    placeholder="Leo"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Sender Email
                  </label>
                  <input
                    type="email"
                    value={newRep.sender_email}
                    onChange={(e) => setNewRep({ ...newRep, sender_email: e.target.value })}
                    placeholder="leo@company.com"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Sender Name
                  </label>
                  <input
                    type="text"
                    value={newRep.sender_name}
                    onChange={(e) => setNewRep({ ...newRep, sender_name: e.target.value })}
                    placeholder="Leo Chen"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    WeChat ID
                  </label>
                  <input
                    type="text"
                    value={newRep.wechat_id}
                    onChange={(e) => setNewRep({ ...newRep, wechat_id: e.target.value })}
                    placeholder="leo_wx"
                    style={inputStyle}
                  />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={handleCreateRep} disabled={savingRep === "new"} className="btn btn-primary">
                  {savingRep === "new" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus />}
                  Add Rep
                </button>
                <button
                  onClick={() => {
                    setShowNewRep(false);
                    setNewRep(EMPTY_REP);
                  }}
                  className="btn"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {reps.length === 0 && !showNewRep && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <User style={{ width: 32, height: 32, color: "var(--text-tertiary)", margin: "0 auto 12px" }} />
              <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 12 }}>
                No sales reps yet
              </p>
              <button onClick={() => setShowNewRep(true)} className="btn btn-primary">
                Add First Rep
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
