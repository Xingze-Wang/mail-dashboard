"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Activity } from "lucide-react";
import { formatDate, getStatusColor, getStatusDot } from "@/lib/utils";

interface LogEvent {
  id: string;
  type: string;
  createdAt: string;
  to?: string;
  subject?: string;
}

type RoleGate = "loading" | "allowed" | "denied";

export default function LogsPage() {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  // Admin-only page: /api/metrics surfaces cross-rep recipient/subject,
  // which sales reps shouldn't see (their own funnel comes from per-rep
  // routes). Gate at mount via /api/auth/me; the API endpoint also adds
  // its own admin check, so this is defense-in-depth, not the only line.
  const [gate, setGate] = useState<RoleGate>("loading");

  const fetchLogs = () => {
    setLoading(true);
    fetch("/api/metrics")
      .then((res) => res.json())
      .then((data) => setEvents(data.recentEvents || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.authenticated && d?.role === "admin") {
          setGate("allowed");
          fetchLogs();
        } else {
          setGate("denied");
        }
      })
      .catch(() => { if (!cancelled) setGate("denied"); });
    return () => { cancelled = true; };
  }, []);

  if (gate === "loading") {
    return (
      <div style={{ padding: 40, fontSize: 13, color: "var(--text-tertiary)" }}>
        Checking permissions…
      </div>
    );
  }
  if (gate === "denied") {
    return (
      <div style={{ padding: 40, maxWidth: 480 }}>
        <h1 className="page-title" style={{ marginBottom: 8 }}>Logs</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Admin only — webhook event logs include cross-rep recipient and
          subject lines. Ask an admin to share specific events if you need
          them.
        </p>
      </div>
    );
  }

  const eventTypes = ["all", "email.sent", "email.delivered", "email.opened", "email.clicked", "email.bounced", "email.complained"];

  const filteredEvents = typeFilter
    ? events.filter((e) => e.type === typeFilter)
    : events;

  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Logs</h1>
          <span className="lead-count">Webhook events</span>
        </div>
        <button onClick={fetchLogs} className="btn">
          <RefreshCw />
          Refresh
        </button>
      </div>

      {/* ── Type Filter ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24, alignItems: "center" }}>
        <div className="status-tabs" style={{ overflowX: "auto" }}>
          {eventTypes.map((t) => {
            const label = t === "all" ? "All" : t.replace("email.", "");
            const isActive = (t === "all" && !typeFilter) || t === typeFilter;
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(t === "all" ? null : t)}
                className={`status-tab ${isActive ? "active" : ""}`}
              >
                {label.charAt(0).toUpperCase() + label.slice(1)}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Event Timeline ── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 50 }} />
          ))}
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Activity style={{ width: 20, height: 20 }} />
          </div>
          <h3>No events yet</h3>
          <p>Webhook events will appear here as emails are sent and delivered.</p>
        </div>
      ) : (
        <div className="section-card" style={{ padding: 0 }}>
          {filteredEvents.map((event, i, arr) => {
            const status = event.type.replace("email.", "");
            return (
              <div
                key={event.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "14px 24px",
                  borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--border-light)",
                  transition: "background 0.15s ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                {/* Timeline dot */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <span className={`h-2 w-2 rounded-full ${getStatusDot(status)}`} />
                </div>

                {/* Event info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`text-[13px] capitalize ${getStatusColor(status)}`} style={{ fontWeight: 600 }}>
                      {status}
                    </span>
                    {event.to && (
                      <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                        to <span style={{ color: "var(--text-secondary)" }}>{event.to}</span>
                      </span>
                    )}
                  </div>
                  {event.subject && (
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--text-tertiary)",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {event.subject}
                    </p>
                  )}
                </div>

                {/* Timestamp */}
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}>
                  {new Date(event.createdAt).toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
