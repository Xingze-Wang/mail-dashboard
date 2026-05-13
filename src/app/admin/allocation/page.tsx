"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2 } from "lucide-react";

interface PageData {
  today: string;
  pool_inventory: Record<string, number>;
  allocations: Array<{
    rep_id: number;
    pool_key: string;
    lead_ids: string[];
    allocator: string;
    notification_status: string | null;
    created_at: string;
  }>;
  missions: Array<{
    id: string;
    rep_id: number;
    target: number;
    scope: { per_pool?: Record<string, number> } | null;
    status: string;
  }>;
  reps: Array<{ id: number; name: string; lark_open_id: string | null }>;
}

export default function AdminAllocationPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/admin/allocation", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await fetch("/api/missions/allocate-leads", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shadow: false }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRunning(false); }
  };

  if (loading) return (
    <div style={{ padding: 24 }}>
      <Loader2 size={14} className="animate-spin" style={{ display: "inline-block", marginRight: 8 }} />
      Loading…
    </div>
  );
  if (error) return <div style={{ padding: 24, color: "#f87171" }}>Error: {error}</div>;
  if (!data) return null;

  const allocByRep = new Map<number, Array<typeof data.allocations[number]>>();
  for (const a of data.allocations) {
    const list = allocByRep.get(a.rep_id) ?? [];
    list.push(a);
    allocByRep.set(a.rep_id, list);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Allocation — {data.today}</h1>
      <p style={{ color: "#94a3b8", marginBottom: 24, fontSize: 13 }}>
        Pool inventory and per-rep allocations for today. Cron runs daily at 09:00 Beijing.
      </p>

      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #1e293b", borderRadius: 8 }}>
        <h2 style={{ fontSize: 14, color: "#94a3b8", marginBottom: 12 }}>Pool inventory (unassigned leads)</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {Object.entries(data.pool_inventory).map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 11, color: "#64748b" }}>{k}</div>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{v}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #1e293b", borderRadius: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, color: "#94a3b8" }}>Today&apos;s allocations</h2>
          <button
            onClick={runNow}
            disabled={running}
            style={{
              padding: "6px 14px", fontSize: 13, fontWeight: 500,
              background: "#6366f1", color: "white",
              border: "none", borderRadius: 6, cursor: "pointer",
            }}
          >
            {running ? "Running…" : "Run allocator now"}
          </button>
        </div>
        <table style={{ width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "#64748b", textAlign: "left", fontSize: 11 }}>
              <th style={{ padding: 6 }}>Rep</th>
              <th style={{ padding: 6 }}>Target</th>
              <th style={{ padding: 6 }}>Got</th>
              <th style={{ padding: 6 }}>By pool</th>
              <th style={{ padding: 6 }}>Allocator</th>
              <th style={{ padding: 6 }}>Notified</th>
            </tr>
          </thead>
          <tbody>
            {data.reps.map((rep) => {
              const m = data.missions.find((x) => x.rep_id === rep.id);
              const allocs = allocByRep.get(rep.id) || [];
              const total = allocs.reduce((sum, a) => sum + (a.lead_ids?.length || 0), 0);
              const byPool = allocs.map((a) => `${a.pool_key}:${a.lead_ids?.length || 0}`).join(", ");
              const notif = allocs[0]?.notification_status ?? "—";
              const allocator = allocs[0]?.allocator ?? "—";
              return (
                <tr key={rep.id} style={{ borderTop: "1px solid #0f172a" }}>
                  <td style={{ padding: 6 }}>{rep.name}</td>
                  <td style={{ padding: 6, color: "#94a3b8" }}>{m?.target ?? "—"}</td>
                  <td style={{ padding: 6, fontWeight: 500 }}>{total || "—"}</td>
                  <td style={{ padding: 6, color: "#94a3b8", fontSize: 12 }}>{byPool || "—"}</td>
                  <td style={{ padding: 6, color: "#64748b", fontSize: 12 }}>{allocator}</td>
                  <td style={{ padding: 6, color: notif === "sent" ? "#10b981" : notif === "failed" ? "#f87171" : "#64748b" }}>
                    {notif}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
