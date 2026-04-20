"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, Loader2, Mail } from "lucide-react";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [email, setEmail] = useState("");
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
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || "Login failed");
        setSubmitting(false);
        return;
      }
      router.replace(next);
      router.refresh();
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
          Email
        </label>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <Mail className="h-4 w-4" style={{ position: "absolute", left: 12, top: 13, color: "var(--text-tertiary)" }} />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            autoComplete="username"
            required
            style={inputStyle}
            placeholder="you@compute.miracleplus.com"
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
          disabled={submitting || !email || !password}
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
            opacity: submitting || !email || !password ? 0.6 : 1,
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
