"use client";

// /congress/discuss — live streaming council deliberation.
// Pick a model + evidence pack (or paste custom evidence), watch the
// personas debate in real time. Each persona's turn streams in as it
// completes, producing a chat-room feel.

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Play, RefreshCw, Users } from "lucide-react";
import { CONGRESS_SAMPLES } from "@/lib/bench-congress";
import { PERSONA_META, type PersonaRole } from "@/lib/congress/types";

const QUICK_MODELS = [
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "gpt-5-mini",
  "gemini-2.5-flash",
  "glm-4.7",
  "qwen3-235b",
];

interface Turn {
  persona: string;
  label: string;
  text: string;
  error?: boolean;
}

const PERSONA_COLOR: Record<string, string> = {
  data_analyst:    "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  copywriter:      "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  academic_proxy:  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  sales_director:  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  psychologist:    "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200",
  adversary:       "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  synthesizer:     "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
};

// Next 16 requires useSearchParams() to be inside a <Suspense> boundary
// or the build emits a warning + the page loses static prerender. Wrap
// the inner component and export a thin Suspense shell.
export default function CongressDiscussPage() {
  return (
    <Suspense fallback={<div style={{ padding: 32, fontSize: 13, color: "var(--text-tertiary)" }}>Loading…</div>}>
      <CongressDiscussInner />
    </Suspense>
  );
}

function CongressDiscussInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");

  // Config
  const [model, setModel] = useState("claude-sonnet-4.6");
  const [sampleIdx, setSampleIdx] = useState(0);
  const [customTitle, setCustomTitle] = useState("");
  const [customEvidence, setCustomEvidence] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const proposalId = params.get("proposalId") ?? undefined;

  // Deliberation state
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d.authenticated && d.role === "admin") setGated("allowed");
      else { setGated("forbidden"); router.replace("/"); }
    }).catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  // Auto-scroll as turns arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const startDeliberation = async () => {
    setTurns([]);
    setDone(false);
    setStreaming(true);

    const body: Record<string, unknown> = { model };
    if (proposalId) {
      body.proposalId = proposalId;
    } else if (useCustom && customTitle && customEvidence) {
      body.title = customTitle;
      body.evidenceText = customEvidence;
    } else {
      body.sampleIdx = sampleIdx;
    }

    try {
      const res = await fetch("/api/congress/discuss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        setTurns([{ persona: "error", label: "Error", text: `HTTP ${res.status}` }]);
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.done) { setDone(true); continue; }
            setTurns((prev) => [...prev, { persona: chunk.persona, label: chunk.label, text: chunk.text, error: chunk.error }]);
          } catch { /* ignore malformed line */ }
        }
      }
    } catch (e) {
      setTurns((prev) => [...prev, { persona: "error", label: "Error", text: String(e) }]);
    }
    setStreaming(false);
  };

  if (gated !== "allowed") {
    return <div className="flex justify-center p-24"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const sample = CONGRESS_SAMPLES[sampleIdx];
  const currentTitle = proposalId ? "Proposal from DB" : useCustom ? customTitle : sample.title;

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Users className="h-6 w-6" />
            Council Discuss
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
            Watch the council deliberate in real time — each persona reasons from the evidence in turn.
          </p>
        </div>
      </div>

      {/* Attribution — runs from this page are sandboxed; bench-sim runs are
           the ones that materialize as company contracts + proposals. */}
      <div style={{
        marginBottom: 22,
        padding: "10px 14px",
        background: "var(--bg)",
        border: "1px solid var(--border-light)",
        borderLeft: "3px solid #94a3b8",
        borderRadius: 8,
        fontSize: 12,
        color: "var(--text-secondary)",
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        flexWrap: "wrap",
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
          color: "var(--text-tertiary)",
        }}>Sandbox</span>
        <span>
          Runs here are read-only — they don&apos;t open contracts, stake capital, or write proposals.
          For runs that flow into the museum wall, use{" "}
          <a href="/bench/sim" style={{ color: "var(--blue, #3B82F6)" }}>/bench/sim</a>.
        </span>
      </div>

      {/* Config panel */}
      {!streaming && (
        <div className="section-card" style={{ marginBottom: 24 }}>
          {/* Model picker */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Model</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {QUICK_MODELS.map((m) => (
                <button key={m} type="button" onClick={() => setModel(m)}
                  className={`dx-chip ${model === m ? "active" : ""}`} style={{ fontSize: 12 }}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Evidence picker — unless proposalId is given */}
          {!proposalId && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Evidence pack</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                {CONGRESS_SAMPLES.map((s, i) => (
                  <button key={s.id} type="button"
                    onClick={() => { setSampleIdx(i); setUseCustom(false); }}
                    className={`dx-chip ${!useCustom && sampleIdx === i ? "active" : ""}`}
                    style={{ fontSize: 12 }}>
                    Pack {i + 1}: {s.title.slice(0, 32)}…
                  </button>
                ))}
                <button type="button"
                  onClick={() => setUseCustom(true)}
                  className={`dx-chip ${useCustom ? "active" : ""}`}
                  style={{ fontSize: 12 }}>
                  Custom…
                </button>
              </div>

              {useCustom && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <input
                    type="text"
                    placeholder="Proposal title"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", fontSize: 13 }}
                  />
                  <textarea
                    placeholder="Paste evidence pack here (stats, context, sample sizes)…"
                    value={customEvidence}
                    onChange={(e) => setCustomEvidence(e.target.value)}
                    rows={6}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace", resize: "vertical" }}
                  />
                </div>
              )}
            </div>
          )}

          {!useCustom && !proposalId && (
            <div style={{ padding: "10px 12px", background: "var(--bg)", borderRadius: 6, fontSize: 12, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
              <strong style={{ color: "var(--text)" }}>Pack {sampleIdx + 1}:</strong> {sample.title}
              <br />
              <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>{sample.evidence.slice(0, 200)}…</span>
            </div>
          )}

          <button
            type="button"
            onClick={startDeliberation}
            disabled={useCustom && (!customTitle || !customEvidence)}
            className="dx-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Play className="h-4 w-4" />
            Start deliberation
          </button>
        </div>
      )}

      {/* Deliberation feed */}
      {(turns.length > 0 || streaming) && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{currentTitle}</div>
            {(done || !streaming) && (
              <button
                type="button"
                onClick={() => { setTurns([]); setDone(false); }}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)", background: "transparent", border: "1px solid var(--border-light)", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                New run
              </button>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {turns.map((turn, i) => {
              const meta = PERSONA_META[turn.persona as PersonaRole];
              const colorClass = PERSONA_COLOR[turn.persona] ?? "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200";
              const isSynth = turn.persona === "synthesizer";

              return (
                <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  {/* Avatar */}
                  <div className={`flex shrink-0 items-center justify-center rounded-full font-medium text-[13px] h-9 w-9 ${colorClass}`}>
                    {meta?.initials ?? turn.persona.slice(0, 2).toUpperCase()}
                  </div>

                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{meta?.label ?? turn.label}</span>
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{meta?.role}</span>
                    </div>
                    <div style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      fontSize: 13,
                      lineHeight: 1.7,
                      background: isSynth ? "var(--dx-blue-soft, #eff6ff)" : "var(--bg)",
                      border: `1px solid ${isSynth ? "var(--blue, #3b82f6)" : "var(--border-light)"}`,
                      color: turn.error ? "var(--coral)" : "var(--text)",
                      whiteSpace: "pre-wrap",
                    }}>
                      {turn.text}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Typing indicator while streaming */}
            {streaming && !done && (
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div className="flex shrink-0 items-center justify-center rounded-full font-medium text-[13px] h-9 w-9 bg-zinc-100 text-zinc-500 dark:bg-zinc-800">
                  …
                </div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Next persona reasoning…
                </div>
              </div>
            )}
          </div>

          <div ref={bottomRef} />

          {/* Done state */}
          {done && (
            <div style={{ marginTop: 16, padding: "12px 16px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border-light)", fontSize: 12, color: "var(--text-secondary)" }}>
              Deliberation complete · {turns.length} turns · model: {model}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
