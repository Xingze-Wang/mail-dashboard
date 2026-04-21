"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Lock, Loader2, User } from "lucide-react";

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || "Login failed");
        setSubmitting(false);
        return;
      }
      // Hard navigation guarantees Sidebar + every page-level useEffect
      // re-runs against the new session cookie. router.replace by itself
      // keeps the Sidebar instance mounted and shows the previous user.
      window.location.assign(next);
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }

  const inputStyle = {
    width: "100%",
    padding: "10px 12px 10px 36px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 14,
    background: "#fff",
    boxSizing: "border-box" as const,
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: 24 }}>
      <form onSubmit={submit} className="section-card" style={{ width: "100%", maxWidth: 380, padding: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <Lock className="h-5 w-5" />
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Qiji Pipeline</h1>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 20px 28px" }}>
          Sign in to continue
        </p>

        <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          Username or email
        </label>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <User className="h-4 w-4" style={{ position: "absolute", left: 12, top: 13, color: "var(--text-tertiary)" }} />
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoFocus
            autoComplete="username"
            required
            style={inputStyle}
            placeholder="xingze"
          />
        </div>

        <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          Password
        </label>
        <div style={{ position: "relative", marginBottom: 16 }}>
          <Lock className="h-4 w-4" style={{ position: "absolute", left: 12, top: 13, color: "var(--text-tertiary)" }} />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={inputStyle}
          />
        </div>

        {error && (
          <div style={{ fontSize: 12, color: "#DC2626", marginBottom: 12 }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={submitting || !identifier || !password}
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
            opacity: submitting || !identifier || !password ? 0.6 : 1,
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
