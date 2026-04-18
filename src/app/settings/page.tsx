"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Plus,
  Save,
  Trash2,
  User,
  Settings,
  Tag,
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
    overseas_override?: { enabled: boolean; rep_id: number };
  };
  category_routing?: {
    enabled: boolean;
    routes: Record<string, number>;
  };
}

const RESEARCH_CATEGORIES = [
  "具身智能/机器人", "多模态/视觉生成", "Agent/自动化", "推理/架构优化",
  "AI安全", "语音/音频", "科学计算/生物", "推理/符号", "其他",
];

const DEFAULT_CATEGORY_ROUTES: Record<string, number> = {
  "具身智能/机器人": 1,
  "多模态/视觉生成": 1,
  "推理/架构优化": 1,
  "AI安全": 1,
  "Agent/自动化": 2,
  "科学计算/生物": 2,
  "推理/符号": 2,
  "语音/音频": 2,
  "其他": 2,
};

const DEFAULT_CONFIG: AssignmentConfig = {
  strong_criteria: { min_h_index: 20, max_school_tier: 2, require_overseas: true },
  assignment: {
    strong: { rep_id: 1 },
    normal: { rep_ids: [2], mode: "round_robin" },
    overseas_override: { enabled: true, rep_id: 1 },
  },
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
        if (configData.strong_criteria) {
          setConfig({
            ...configData,
            category_routing: configData.category_routing ?? {
              enabled: false,
              routes: DEFAULT_CATEGORY_ROUTES,
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
        <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginBottom: 20, lineHeight: 1.5 }}>
          Define what makes a Strong lead and how leads are routed to your sales reps.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>
          {/* Min h-index */}
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
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
              style={inputStyle}
            />
          </div>

          {/* Max school tier */}
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
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
              style={inputStyle}
            />
          </div>

          {/* Require overseas */}
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Require Overseas
            </label>
            <select
              className="filter-select"
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
              style={{ width: "100%", padding: "8px 28px 8px 12px", fontSize: 13 }}
            >
              <option value="yes">Yes — only non-.cn emails</option>
              <option value="no">No — all emails qualify</option>
            </select>
          </div>
        </div>

        {/* Assignment mapping */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Strong Leads → Rep
            </label>
            <select
              className="filter-select"
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
              style={{ width: "100%", padding: "8px 28px 8px 12px", fontSize: 13 }}
            >
              {reps.filter((r) => r.active).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Normal Leads → Round Robin Reps
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
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
                    style={{
                      borderRadius: "var(--radius-sm)",
                      padding: "6px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: isSelected ? "1px solid #BFDBFE" : "1px solid var(--border)",
                      background: isSelected ? "var(--blue-bg)" : "var(--card)",
                      color: isSelected ? "var(--blue)" : "var(--text-secondary)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {r.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Overseas override */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Overseas Override
            </label>
            <select
              className="filter-select"
              value={config.assignment.overseas_override?.enabled ? "yes" : "no"}
              onChange={(e) =>
                setConfig({
                  ...config,
                  assignment: {
                    ...config.assignment,
                    overseas_override: {
                      enabled: e.target.value === "yes",
                      rep_id: config.assignment.overseas_override?.rep_id ?? config.assignment.strong.rep_id,
                    },
                  },
                })
              }
              style={{ width: "100%", padding: "8px 28px 8px 12px", fontSize: 13 }}
            >
              <option value="yes">Yes — all overseas leads to one rep</option>
              <option value="no">No — follow normal round-robin</option>
            </select>
          </div>

          {config.assignment.overseas_override?.enabled && (
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Overseas → Rep
              </label>
              <select
                className="filter-select"
                value={config.assignment.overseas_override?.rep_id ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    assignment: {
                      ...config.assignment,
                      overseas_override: {
                        enabled: true,
                        rep_id: parseInt(e.target.value),
                      },
                    },
                  })
                }
                style={{ width: "100%", padding: "8px 28px 8px 12px", fontSize: 13 }}
              >
                {reps.filter((r) => r.active).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Preview */}
        <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "var(--text-tertiary)" }}>
            <span>
              Strong: h-index ≥{" "}
              <strong style={{ color: "var(--text)" }}>{config.strong_criteria.min_h_index}</strong>,
              tier ≤{" "}
              <strong style={{ color: "var(--text)" }}>{config.strong_criteria.max_school_tier}</strong>
              {" → "}
              <strong style={{ color: "var(--text)" }}>
                {reps.find((r) => r.id === config.assignment.strong.rep_id)?.name || "?"}
              </strong>
            </span>
            {config.assignment.overseas_override?.enabled && (
              <span>
                Overseas →{" "}
                <strong style={{ color: "var(--text)" }}>
                  {reps.find((r) => r.id === config.assignment.overseas_override?.rep_id)?.name || "?"}
                </strong>
              </span>
            )}
            <span>
              Rest: round-robin →{" "}
              <strong style={{ color: "var(--text)" }}>
                {config.assignment.normal.rep_ids
                  .map((id) => reps.find((r) => r.id === id)?.name || "?")
                  .join(", ")}
              </strong>
            </span>
          </div>
          <button onClick={handleSaveConfig} disabled={savingConfig} className="btn btn-primary">
            {savingConfig ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save />}
            Save Rules
          </button>
        </div>
      </div>

      {/* ═══ Category Routing ═══ */}
      <div className="section-card" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Tag style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
            <h3 style={{ marginBottom: 0 }}>Category Routing</h3>
          </div>
          <button
            onClick={() => {
              const current = config.category_routing ?? { enabled: false, routes: DEFAULT_CATEGORY_ROUTES };
              setConfig({
                ...config,
                category_routing: { ...current, enabled: !current.enabled },
              });
            }}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              height: 22,
              width: 40,
              borderRadius: 999,
              background: config.category_routing?.enabled ? "var(--blue)" : "var(--border)",
              border: "none",
              cursor: "pointer",
              transition: "background 0.15s ease",
              padding: 0,
            }}
          >
            <span
              style={{
                display: "inline-block",
                height: 16,
                width: 16,
                borderRadius: "50%",
                background: "white",
                transition: "transform 0.15s ease",
                transform: config.category_routing?.enabled ? "translateX(21px)" : "translateX(3px)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
              }}
            />
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginBottom: 20, lineHeight: 1.5 }}>
          Override default round-robin by routing leads to specific reps based on their research category.
        </p>

        {config.category_routing?.enabled && (() => {
          const routes = config.category_routing?.routes ?? DEFAULT_CATEGORY_ROUTES;
          const activeReps = reps.filter((r) => r.active);
          const repCounts = new Map<string, number>();
          for (const cat of RESEARCH_CATEGORIES) {
            const repId = routes[cat] ?? DEFAULT_CATEGORY_ROUTES[cat];
            const repName = reps.find((r) => r.id === repId)?.name ?? "?";
            repCounts.set(repName, (repCounts.get(repName) ?? 0) + 1);
          }

          return (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
                {RESEARCH_CATEGORIES.map((cat) => (
                  <div
                    key={cat}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-light)",
                      background: "var(--bg)",
                      padding: "10px 12px",
                    }}
                  >
                    <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 8 }}>
                      {cat}
                    </span>
                    <select
                      className="filter-select"
                      value={routes[cat] ?? DEFAULT_CATEGORY_ROUTES[cat]}
                      onChange={(e) => {
                        const newRoutes = { ...routes, [cat]: parseInt(e.target.value) };
                        setConfig({
                          ...config,
                          category_routing: {
                            enabled: true,
                            routes: newRoutes,
                          },
                        });
                      }}
                      style={{ padding: "4px 22px 4px 8px", fontSize: 11 }}
                    >
                      {activeReps.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {/* Summary */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, color: "var(--text-tertiary)" }}>
                {[...repCounts.entries()].map(([name, count]) => (
                  <span key={name}>
                    <strong style={{ color: "var(--text)" }}>{name}</strong>: {count}{" "}
                    {count === 1 ? "category" : "categories"}
                  </span>
                ))}
              </div>
            </>
          );
        })()}

        {!config.category_routing?.enabled && (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            When enabled, leads are routed to reps based on their research category instead of the default round-robin.
          </p>
        )}
      </div>

      {/* ═══ Sales Reps ═══ */}
      <div className="section-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <User style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
            <h3 style={{ marginBottom: 0 }}>Sales Reps</h3>
            <span className="lead-count">{reps.filter((r) => r.active).length} active</span>
          </div>
          {!showNewRep && (
            <button onClick={() => setShowNewRep(true)} className="btn">
              <Plus />
              Add Rep
            </button>
          )}
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginBottom: 20, lineHeight: 1.5 }}>
          Sender identities used when emailing leads. Email and WeChat ID appear in the outgoing message footer.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Existing reps */}
          {reps.map((rep) => (
            <div
              key={rep.id}
              style={{
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--card)",
                padding: 16,
                opacity: rep.active ? 1 : 0.5,
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
          ))}

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
            <div className="empty-state" style={{ border: "none", padding: "32px 0" }}>
              <div className="empty-icon">
                <User style={{ width: 20, height: 20 }} />
              </div>
              <h3>No sales reps yet</h3>
              <p>Add your first rep to start assigning leads.</p>
              <button onClick={() => setShowNewRep(true)} className="btn btn-primary" style={{ marginTop: 14 }}>
                <Plus />
                Add First Rep
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
