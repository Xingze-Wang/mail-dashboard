"use client";

// Floating draggable help-bot widget. Lives in the app shell (every page
// except /login). Click → chat modal. Knows the sales guide + Qiji compute
// facts via /api/help/ask.
//
// Drag: hold the avatar, move; position persists per-browser via
// localStorage. Click without dragging → open chat. Hidden on /login.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sparkles, X, Send, Loader2, MessageCircle, BookOpen } from "lucide-react";

const STORAGE_KEY = "help_bot_pos_v1";
const DRAG_THRESHOLD_PX = 6;

interface Pos { x: number; y: number }
interface Msg { id: number; role: "user" | "assistant"; text: string }

/** Shape of the window global that ReviewPane publishes when a lead is on
 *  screen. Read synchronously on modal open (not subscribed) because the
 *  user can't change leads while this modal is open. */
interface CurrentReviewLead { id: string; title: string }
declare global {
  interface Window { __currentReviewLead?: CurrentReviewLead }
}

type BotMode = "sales" | "paper";

const SALES_SUGGESTIONS = [
  "怎么发邮件? 在哪里点 Send?",
  "对方说「我已经有 NSF grant 了」怎么回?",
  "怎么换收件人到一作?",
  "看不到任何 leads 是为什么?",
  "对方问我们和云代金券有什么不同?",
  "我标错了 Flag 怎么办?",
];

const PAPER_SUGGESTIONS = [
  "这篇论文一句话讲的是什么？",
  "核心 contribution 是什么？",
  "用了什么方法 / 什么模型？",
  "为什么这种研究需要很多算力？",
  "这个方向现在是什么状态 (领域 context)？",
];

export function HelpBot() {
  const pathname = usePathname() || "";
  const [pos, setPos] = useState<Pos>({ x: 24, y: 24 }); // bottom-right offsets
  const [open, setOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origPos: Pos; moved: boolean } | null>(null);

  // Load saved position
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
          setPos(parsed);
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Don't show on login page (no auth, would float over the form ugly)
  if (pathname.startsWith("/login")) return null;

  function clampPos(p: Pos): Pos {
    if (typeof window === "undefined") return p;
    const maxX = Math.max(0, window.innerWidth - 80);
    const maxY = Math.max(0, window.innerHeight - 80);
    return { x: Math.max(8, Math.min(p.x, maxX)), y: Math.max(8, Math.min(p.y, maxY)) };
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origPos: pos,
      moved: false,
    };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (!dragRef.current.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    dragRef.current.moved = true;
    // We position from bottom-right, so a drag right reduces x, drag down reduces y.
    setPos(clampPos({
      x: Math.max(8, dragRef.current.origPos.x - dx),
      y: Math.max(8, dragRef.current.origPos.y - dy),
    }));
  }
  function onPointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (!dragRef.current) return;
    const wasDrag = dragRef.current.moved;
    dragRef.current = null;
    if (wasDrag) {
      // Persist
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
    } else {
      // Treated as a click → open chat
      setOpen(true);
    }
  }

  return (
    <>
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Sales Helper — drag me anywhere, click to ask"
        style={{
          position: "fixed",
          bottom: pos.y,
          right: pos.x,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #6366F1 0%, #EC4899 100%)",
          color: "white",
          border: "none",
          cursor: "grab",
          touchAction: "none",
          boxShadow: "0 8px 24px rgba(99,102,241,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 60,
          userSelect: "none",
        }}
      >
        <Sparkles style={{ width: 22, height: 22 }} />
      </button>
      {open && <HelpModal pathname={pathname} onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpModal({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  // Read the current review lead once on open — the user can't change
  // papers while this modal is up, so snapshotting is safe and avoids
  // having to subscribe to window changes.
  const [currentLead] = useState<CurrentReviewLead | null>(() => {
    if (typeof window === "undefined") return null;
    return window.__currentReviewLead ?? null;
  });

  // Default to paper-tutor mode if a lead is in scope (user is in Review
  // pane staring at a paper — that's almost always what they want to ask
  // about). Fall back to sales mode elsewhere.
  const [mode, setMode] = useState<BotMode>(currentLead ? "paper" : "sales");

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Clear conversation when switching modes — a paper-comprehension thread
  // has no business continuing into a sales-playbook context (and vice
  // versa); mixing them would confuse both the user and the LLM.
  const switchMode = useCallback((next: BotMode) => {
    if (next === mode) return;
    setMode(next);
    setMessages([]);
    setErr(null);
  }, [mode]);

  const send = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setErr(null);
    const next: Msg[] = [...messages, { id: Date.now(), role: "user", text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const history = next.slice(-5).slice(0, -1).map((m) => ({ role: m.role, text: m.text }));
      const url = mode === "paper" ? "/api/help/paper" : "/api/help/ask";
      const payload = mode === "paper" && currentLead
        ? { leadId: currentLead.id, question: text, history }
        : { question: text, currentPath: pathname, history };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "Failed");
      } else {
        setMessages([...next, { id: Date.now() + 1, role: "assistant", text: d.answer ?? "" }]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [messages, busy, pathname, mode, currentLead]);

  // Esc / Cmd+Enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (input.trim() && !busy) send(input);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input, busy, send, onClose]);

  // Auto-scroll on new message
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "flex-end", justifyContent: "flex-end",
        zIndex: 70, padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 92vw)", height: "min(640px, 80vh)",
          background: "var(--card, #fff)",
          borderRadius: 14,
          border: "1px solid var(--border, #e5e7eb)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* header — title reflects active mode so sales knows whether
            they're in sales-script territory or paper-comprehension territory */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 16px",
          borderBottom: "1px solid var(--border-light, #f3f4f6)",
          background: "linear-gradient(180deg, rgba(99,102,241,0.04) 0%, transparent 100%)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <Sparkles style={{ width: 16, height: 16, color: "#6366F1", flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {mode === "paper" ? "Paper Tutor" : "Sales Helper"}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary, #9ca3af)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 320,
                }}
                title={mode === "paper" && currentLead ? currentLead.title : undefined}
              >
                {mode === "paper" && currentLead
                  ? `读懂: ${currentLead.title}`
                  : "有问题随时问 — 知道这 app 怎么用 + 算力项目所有 facts"}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{ background: "transparent", border: 0, color: "var(--text-tertiary, #9ca3af)", cursor: "pointer", padding: 4, lineHeight: 0, flexShrink: 0 }}
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* Mode toggle — only shows when a lead is in scope. Outside
            Review mode there's no "paper" to tutor on, so the toggle would
            just be a dead button. */}
        {currentLead && (
          <div style={{ display: "flex", gap: 0, padding: "8px 12px 0 12px", borderBottom: "1px solid var(--border-light, #f3f4f6)" }}>
            <ModeTab
              active={mode === "paper"}
              onClick={() => switchMode("paper")}
              icon={<BookOpen style={{ width: 12, height: 12 }} />}
              label="读论文"
            />
            <ModeTab
              active={mode === "sales"}
              onClick={() => switchMode("sales")}
              icon={<MessageCircle style={{ width: 12, height: 12 }} />}
              label="销售帮助"
            />
          </div>
        )}

        {/* messages */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ fontSize: 12.5, color: "var(--text-tertiary, #6b7280)", lineHeight: 1.55 }}>
                {mode === "paper"
                  ? "我只负责帮你读懂这篇 paper — 不会告诉你怎么发邮件（切到「销售帮助」问那个）。"
                  : "问任何 UI 操作或者「对方问 X 怎么回」的话术。我用奇绩官网 facts + sales 手册回答。"}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(mode === "paper" ? PAPER_SUGGESTIONS : SALES_SUGGESTIONS).map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    style={{
                      fontSize: 12, textAlign: "left", padding: "8px 10px",
                      background: "var(--bg, #f9fafb)",
                      border: "1px solid var(--border-light, #f3f4f6)",
                      borderRadius: 6, cursor: "pointer",
                      color: "var(--text-secondary, #4b5563)",
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%", padding: "8px 12px",
                fontSize: 13, lineHeight: 1.55, borderRadius: 10,
                background: m.role === "user" ? "#6366F1" : "var(--bg, #f9fafb)",
                color: m.role === "user" ? "white" : "var(--text, #111827)",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}
            >
              {m.text}
            </div>
          ))}
          {busy && (
            <div style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-tertiary, #9ca3af)", padding: "6px 10px" }}>
              <Loader2 style={{ width: 13, height: 13 }} className="spin" />
              thinking…
            </div>
          )}
          {err && (
            <div style={{ alignSelf: "flex-start", padding: "8px 10px", fontSize: 12, color: "#dc2626", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6 }}>
              {err}
            </div>
          )}
        </div>

        {/* input */}
        <div style={{ padding: 10, borderTop: "1px solid var(--border-light, #f3f4f6)", display: "flex", gap: 6 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline (standard chat UX).
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && !busy) send(input);
              }
            }}
            placeholder={mode === "paper" ? "问关于这篇 paper 的任何问题…  (Enter 发送)" : "问一个问题…  (Enter 发送, Shift+Enter 换行)"}
            rows={2}
            style={{
              flex: 1, padding: "8px 10px", fontSize: 13, lineHeight: 1.5,
              border: "1px solid var(--border, #e5e7eb)", borderRadius: 6,
              background: "var(--card, #fff)", color: "var(--text, #111827)",
              resize: "none", boxSizing: "border-box", outline: "none", fontFamily: "inherit",
            }}
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            style={{
              padding: "0 14px",
              background: input.trim() && !busy ? "#6366F1" : "var(--bg, #f9fafb)",
              color: input.trim() && !busy ? "white" : "var(--text-tertiary, #9ca3af)",
              border: 0, borderRadius: 6,
              cursor: input.trim() && !busy ? "pointer" : "not-allowed",
              display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12,
            }}
          >
            <Send style={{ width: 13, height: 13 }} />
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "6px 10px",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        color: active ? "#6366F1" : "var(--text-tertiary, #9ca3af)",
        background: "transparent",
        border: 0,
        borderBottom: active ? "2px solid #6366F1" : "2px solid transparent",
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
