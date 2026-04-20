"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, Loader2 } from "lucide-react";

interface Rep {
  id: number;
  name: string;
  sender_email: string;
  wechat_id: string | null;
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [reps, setReps] = useState<Rep[]>([]);
  const [repId, setRepId] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/reps")
      .then((r) => r.json())
      .then((d) => {
        const list = (d.reps ?? []) as Rep[];
        setReps(list);
        if (list.length > 0) setRepId(list[0].id);
      })
      .catch(() => setError("Couldn't load reps"));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!repId) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, repId }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || "Login failed");
        setSubmitting(false);
        return;
      }
      router.replace(next);
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: 24 }}>
      <form
        onSubmit={submit}
        className="section-card"
        style={{ width: "100%", maxWidth: 380, padding: 28 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <Lock className="h-5 w-5" />
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Qiji Pipeline</h1>
        </div>

        <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          I am
        </label>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(reps.length, 1)}, 1fr)`, gap: 8, marginBottom: 16 }}>
          {reps.map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => setRepId(r.id)}
              className={`dx-chip ${repId === r.id ? "active" : ""}`}
              style={{ padding: "8px 10px" }}
            >
              {r.name}
            </button>
          ))}
        </div>

        <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          style={{
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 14,
            marginBottom: 14,
            background: "#fff",
          }}
        />

        {error && (
          <div style={{ fontSize: 12, color: "#DC2626", marginBottom: 12 }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={submitting || !password || !repId}
          style={{
            width: "100%",
            padding: "10px 12px",
            background: "#1A1A1A",
            color: "#fff",
            border: 0,
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            cursor: submitting ? "default" : "pointer",
            opacity: submitting || !password || !repId ? 0.6 : 1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Sign in
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}>Loading…</div>}>
      <LoginInner />
    </Suspense>
  );
}
