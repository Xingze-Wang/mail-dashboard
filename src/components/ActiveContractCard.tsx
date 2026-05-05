// Read-only header card for the rep's currently active contract.
// Shows: company that staked it, the action being asked for, target points,
// running points, time remaining. No buttons that mutate — overrides flow
// through helper bot or by simply doing the rep's job differently.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Briefcase } from "lucide-react";

interface Contract {
  id: string;
  action_label: string;
  prediction: string;
  segment: string | null;
  target_score: number;
  running_score: number;
  capital_staked: number;
  opened_at: string;
  closes_at: string;
  company: { name: string; color: string; thesis: string | null };
}

export function ActiveContractCard() {
  const [contract, setContract] = useState<Contract | null>(null);
  const [scope, setScope] = useState<"rep" | "company" | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/contracts/active")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setContract(d.contract ?? null);
        setScope(d.scope ?? null);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  if (!loaded || !contract) return null;

  const c = contract;
  const pct = Math.min(100, (Number(c.running_score) / Math.max(1, Number(c.target_score))) * 100);
  const closes = new Date(c.closes_at).getTime();
  const now = Date.now();
  const hoursLeft = Math.max(0, Math.round((closes - now) / 3_600_000));
  const days = Math.floor(hoursLeft / 24);
  const remaining = days > 0 ? `${days}d` : `${hoursLeft}h`;
  const onTrack = pct >= 50;

  return (
    <div style={{
      margin: "12px 0 16px",
      padding: "14px 16px",
      background: "var(--card)",
      border: "1px solid var(--border-light)",
      borderLeft: `3px solid ${c.company.color}`,
      borderRadius: 12,
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 14,
      alignItems: "center",
    }}>
      <div style={{
        width: 36, height: 36,
        borderRadius: 8,
        background: `${c.company.color}20`,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>
        <Briefcase style={{ width: 16, height: 16, color: c.company.color }} />
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {scope === "rep" ? "Your contract" : "Company-wide"} · {c.company.name}
          </span>
          {c.segment && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>· {c.segment}</span>}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.action_label}
        </div>
        {c.prediction && (
          <div style={{ marginTop: 2, fontSize: 11.5, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.prediction}
          </div>
        )}
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              width: `${pct}%`,
              height: "100%",
              background: onTrack ? "#16a34a" : "#d97706",
              borderRadius: 3,
              transition: "width 0.4s ease",
            }} />
          </div>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {Number(c.running_score).toFixed(0)} / {Number(c.target_score).toFixed(0)} pts
          </span>
        </div>
      </div>

      <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
          {remaining} left
        </span>
        <Link href="/congress/timeline" style={{ fontSize: 11, color: "#3B82F6", textDecoration: "none" }}>
          see all →
        </Link>
      </div>
    </div>
  );
}
