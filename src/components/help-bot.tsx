"use client";

// Floating draggable help-bot widget. Lives in the app shell (every page
// except /login). Click → chat modal. Knows the sales guide + Qiji compute
// facts via /api/help/ask.
//
// Drag: hold the avatar, move; position persists per-browser via
// localStorage. Click without dragging → open chat. Hidden on /login.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sparkles, X, Send, Loader2, Plus, Clock, Check } from "lucide-react";

const STORAGE_KEY = "help_bot_pos_v1";
const DRAG_THRESHOLD_PX = 6;

interface Pos { x: number; y: number }
interface ToolProposal {
  action: string;
  [key: string]: unknown;
}
interface Msg {
  id: number;
  role: "user" | "assistant" | "tool";
  text: string;
  proposal?: ToolProposal | null;
  toolResult?: { ok: boolean; detail?: Record<string, unknown> } | null;
  // Breadcrumbs for read-only tools the helper invoked while composing
  // this message (e.g., [list_leads: 5 leads, get_my_stats: stats]).
  // Rendered as a muted strip above the bubble so sales can see what
  // data the helper looked at.
  toolTrail?: Array<{ tool: string; summary: string }>;
}

/** Shape of the window global that ReviewPane publishes when a lead is on
 *  screen. Read synchronously on modal open (not subscribed) because the
 *  user can't change leads while this modal is open. */
interface CurrentReviewLead { id: string; title: string }
declare global {
  interface Window { __currentReviewLead?: CurrentReviewLead }
}


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
  const [pos, setPos] = useState<Pos>({ x: 24, y: 24 });
  const [open, setOpen] = useState(false);
  // Pending nudge — when the helper proactively wants to say something.
  // Rendered as a speech bubble next to the sparkles button until
  // the user opens the modal (which consumes it) or dismisses.
  const [pendingNudge, setPendingNudge] = useState<string | null>(null);
  // Pending opener — the daily greeting. Seeded once per Beijing day
  // when the user first opens the modal.
  const [pendingOpener, setPendingOpener] = useState<string | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNudgedLeadRef = useRef<string | null>(null);
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

  // Fetch the daily opener. Returns {skip: true} if already greeted
  // today, else {greeting}. Runs once per mount, but the server-side
  // dedup ensures it's only meaningful the first time per Beijing day.
  useEffect(() => {
    if (pathname.startsWith("/login")) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/help/opening");
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && !d.skip && typeof d.greeting === "string") {
          setPendingOpener(d.greeting);
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [pathname]);

  // Review-linger nudge — if a rep stays on the same lead for 15s
  // without opening the helper, the helper pops a bubble. De-dup per
  // lead id so the same paper can't re-nudge.
  useEffect(() => {
    // Only applies on review mode. We poll window.__currentReviewLead
    // on a slow interval (1s) to pick up cursor changes.
    if (open) return; // modal already open — don't nudge
    let currentLeadId: string | null = null;

    const checkLead = () => {
      if (typeof window === "undefined") return;
      const next = window.__currentReviewLead?.id ?? null;
      if (next !== currentLeadId) {
        currentLeadId = next;
        if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
        if (!next || next === lastNudgedLeadRef.current) return;
        // Start a 15s timer for THIS lead.
        nudgeTimerRef.current = setTimeout(async () => {
          // Double-check the user is still on this lead + modal still closed.
          if (open || window.__currentReviewLead?.id !== next) return;
          try {
            const r = await fetch("/api/help/nudge", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ leadId: next }),
            });
            if (!r.ok) return;
            const d = await r.json();
            if (d.skip) return;
            // Final check: user hasn't moved.
            if (open || window.__currentReviewLead?.id !== next) return;
            lastNudgedLeadRef.current = next;
            setPendingNudge(d.nudge);
          } catch { /* non-fatal */ }
        }, 15_000);
      }
    };

    const interval = setInterval(checkLead, 1000);
    checkLead(); // initial
    return () => {
      clearInterval(interval);
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    };
  }, [open]);

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

      {/* Pending nudge bubble — sits to the LEFT of the sparkles.
          Click opens the modal and seeds the nudge as an assistant
          message. The X button dismisses without opening. */}
      {pendingNudge && !open && (
        <div
          style={{
            position: "fixed",
            bottom: pos.y + 8,
            right: pos.x + 64,
            zIndex: 61,
            background: "white",
            color: "var(--text, #111827)",
            borderRadius: 12,
            padding: "10px 14px",
            maxWidth: 280,
            fontSize: 13,
            lineHeight: 1.4,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            border: "1px solid var(--border, #e5e7eb)",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <button
            onClick={() => {
              // Consume as the modal's opener seed.
              setPendingOpener(pendingNudge);
              setPendingNudge(null);
              setOpen(true);
            }}
            style={{ all: "unset", cursor: "pointer", flex: 1 }}
          >
            {pendingNudge}
          </button>
          <button
            onClick={() => setPendingNudge(null)}
            title="Dismiss"
            style={{ background: "transparent", border: 0, color: "var(--text-tertiary, #9ca3af)", cursor: "pointer", padding: 0, lineHeight: 0 }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
      )}

      {open && (
        <HelpModal
          pathname={pathname}
          onClose={() => setOpen(false)}
          initialSeed={pendingOpener}
          onConsumeSeed={() => setPendingOpener(null)}
        />
      )}
    </>
  );
}

function HelpModal({
  pathname,
  onClose,
  initialSeed,
  onConsumeSeed,
}: {
  pathname: string;
  onClose: () => void;
  initialSeed?: string | null;
  onConsumeSeed?: () => void;
}) {
  const [currentLead] = useState<CurrentReviewLead | null>(() => {
    if (typeof window === "undefined") return null;
    return window.__currentReviewLead ?? null;
  });

  // Seed the daily opener / nudge as the first assistant message so
  // the helper feels like a presence that "said hi first".
  const [messages, setMessages] = useState<Msg[]>(() => {
    if (initialSeed) {
      return [{ id: Date.now(), role: "assistant", text: initialSeed }];
    }
    return [];
  });
  useEffect(() => {
    if (initialSeed && onConsumeSeed) onConsumeSeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Conversation persistence — created lazily on first user message.
  // One endpoint now, no mode split.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Array<{ id: string; title: string | null; mode: string; updated_at: string }>>([]);

  // Lazy-create a conversation for persistence. One unified chat now.
  const ensureConversation = useCallback(async (firstMessage: string): Promise<string | null> => {
    if (conversationId) return conversationId;
    try {
      const r = await fetch("/api/help/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "sales", title: firstMessage.slice(0, 120) }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (d.conversation?.id) {
        setConversationId(d.conversation.id);
        return d.conversation.id;
      }
    } catch {
      // non-fatal — chat still works without persistence
    }
    return null;
  }, [conversationId]);

  const send = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setErr(null);
    const next: Msg[] = [...messages, { id: Date.now(), role: "user", text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const convId = await ensureConversation(text);
      const inlineHistory = next.slice(-5).slice(0, -1)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, text: m.text }));
      // One endpoint, one payload. currentLeadId is passed when rep is
      // in Review so the agent can answer paper questions naturally.
      const payload: Record<string, unknown> = {
        question: text,
        currentPath: pathname,
        history: inlineHistory,
      };
      if (currentLead) payload.currentLeadId = currentLead.id;
      if (convId) payload.conversationId = convId;

      const r = await fetch("/api/help/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "Failed");
      } else {
        setMessages([...next, {
          id: Date.now() + 1,
          role: "assistant",
          text: d.answer ?? "",
          proposal: d.proposal ?? null,
          toolTrail: Array.isArray(d.toolTrail) ? d.toolTrail : undefined,
        }]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [messages, busy, pathname, currentLead, ensureConversation]);

  // Confirm + execute a tool proposal. The LLM only suggests — this
  // click is the ONLY way an action runs server-side. Result is
  // appended as a synthetic 'tool' message so the thread stays
  // auditable.
  const executeProposal = useCallback(async (msgId: number, proposal: ToolProposal) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/help/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, proposal }),
      });
      const d = await r.json();
      setMessages((prev) => [
        ...prev.map((m) => m.id === msgId ? { ...m, proposal: null } : m), // consume proposal
        {
          id: Date.now() + 2,
          role: "tool" as const,
          text: "",
          toolResult: { ok: !!d.ok, detail: d.detail ?? d },
        },
      ]);
      if (!r.ok) setErr(d.error ?? "Execute failed");
      // review_next is a frontend navigate — server returns the path;
      // we redirect. Small delay so sales sees the "Executed" strip first.
      if (r.ok && proposal.action === "review_next") {
        const nav = (d.detail as { navigate?: string } | undefined)?.navigate;
        if (nav && typeof window !== "undefined") {
          setTimeout(() => { window.location.href = nav; }, 400);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  // Cancel a proposal (don't execute) — just strip it so the confirm
  // card goes away.
  const cancelProposal = useCallback((msgId: number) => {
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, proposal: null } : m));
  }, []);

  // Open history panel — fetch list.
  const openHistory = useCallback(async () => {
    setShowHistory(true);
    try {
      const r = await fetch("/api/help/conversations");
      if (!r.ok) return;
      const d = await r.json();
      setHistory(d.conversations ?? []);
    } catch { /* non-fatal */ }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/help/conversations/${id}`);
      if (!r.ok) return;
      const d = await r.json();
      setConversationId(id);
      setMessages(
        (d.messages ?? []).map((m: { id: string; role: string; text: string | null; tool_proposal: ToolProposal | null; tool_result: { ok: boolean; detail?: Record<string, unknown> } | null }, i: number) => ({
          id: Date.now() + i,
          role: (m.role as "user" | "assistant" | "tool"),
          text: m.text ?? "",
          proposal: m.tool_proposal ?? null,
          toolResult: m.tool_result ?? null,
        })),
      );
      setShowHistory(false);
    } catch { /* non-fatal */ }
  }, []);

  const newConversation = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setInput("");
    setErr(null);
    setShowHistory(false);
  }, []);

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
          position: "relative",
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
                Helper
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
                title={currentLead?.title}
              >
                {currentLead ? `reviewing: ${currentLead.title}` : "问问题, 发邮件, 查数据都可以"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <button
              onClick={newConversation}
              title="New conversation"
              style={{ background: "transparent", border: 0, color: "var(--text-tertiary, #9ca3af)", cursor: "pointer", padding: 4, lineHeight: 0 }}
            >
              <Plus style={{ width: 16, height: 16 }} />
            </button>
            <button
              onClick={openHistory}
              title="Past conversations"
              style={{ background: "transparent", border: 0, color: "var(--text-tertiary, #9ca3af)", cursor: "pointer", padding: 4, lineHeight: 0 }}
            >
              <Clock style={{ width: 16, height: 16 }} />
            </button>
            <button
              onClick={onClose}
              title="Close (Esc)"
              style={{ background: "transparent", border: 0, color: "var(--text-tertiary, #9ca3af)", cursor: "pointer", padding: 4, lineHeight: 0 }}
            >
              <X style={{ width: 18, height: 18 }} />
            </button>
          </div>
        </div>

        {/* History panel — slides over the chat. Click a past thread
            to load it; click anywhere else to dismiss. */}
        {showHistory && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--card, #fff)",
              zIndex: 2,
              padding: 12,
              overflowY: "auto",
              borderRadius: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Past conversations</div>
              <button
                onClick={() => setShowHistory(false)}
                style={{ background: "transparent", border: 0, color: "var(--text-tertiary, #9ca3af)", cursor: "pointer", padding: 4, lineHeight: 0 }}
              >
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
            {history.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-tertiary, #9ca3af)", padding: 24, textAlign: "center" }}>
                No past conversations yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {history.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => loadConversation(h.id)}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      fontSize: 12.5,
                      border: "1px solid var(--border, #e5e7eb)",
                      borderRadius: 6,
                      background: "var(--bg, #f9fafb)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {h.title || "(untitled)"}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary, #9ca3af)", marginTop: 2 }}>
                      {new Date(h.updated_at).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* messages */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ fontSize: 12.5, color: "var(--text-tertiary, #6b7280)", lineHeight: 1.55 }}>
                问问题, 查数据, 或者让我帮你做事.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(currentLead ? PAPER_SUGGESTIONS : SALES_SUGGESTIONS).map((q) => (
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
          {messages.map((m) => {
            // Tool-result rows: not a chat bubble — a small audit strip.
            if (m.role === "tool") {
              const ok = m.toolResult?.ok;
              return (
                <div
                  key={m.id}
                  style={{
                    alignSelf: "stretch",
                    padding: "8px 10px",
                    fontSize: 11.5,
                    borderRadius: 8,
                    background: ok ? "#F0FDF4" : "#FEF2F2",
                    border: "1px solid " + (ok ? "#BBF7D0" : "#FECACA"),
                    color: ok ? "#166534" : "#991B1B",
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {ok ? "✓ Executed" : "✗ Failed"} · {JSON.stringify(m.toolResult?.detail ?? {}).slice(0, 200)}
                </div>
              );
            }
            return (
              <div key={m.id} style={{ alignSelf: "stretch", display: "flex", flexDirection: "column", gap: 6 }}>
                {/* Tool trail — shown above the assistant bubble so sales
                    knows the helper actually looked at real data before
                    answering. Silent on user bubbles. */}
                {m.role === "assistant" && m.toolTrail && m.toolTrail.length > 0 && (
                  <div
                    style={{
                      alignSelf: "flex-start",
                      fontSize: 10.5,
                      color: "var(--text-tertiary, #9ca3af)",
                      fontFamily: "ui-monospace, monospace",
                      paddingLeft: 2,
                    }}
                    title={m.toolTrail.map((t) => `${t.tool}: ${t.summary}`).join("\n")}
                  >
                    ↳ {m.toolTrail.map((t) => `${t.tool} (${t.summary})`).join(" · ")}
                  </div>
                )}
                <div
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
                {/* Tool proposal card — rendered when the LLM suggested
                    an action. User MUST click Confirm for it to execute.
                    No auto-firing, ever. */}
                {m.proposal && (
                  <ProposalCard
                    proposal={m.proposal}
                    onConfirm={() => executeProposal(m.id, m.proposal!)}
                    onCancel={() => cancelProposal(m.id)}
                    busy={busy}
                  />
                )}
              </div>
            );
          })}
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
            placeholder="问问题, 或者让我帮你做事…  (Enter 发送, Shift+Enter 换行)"
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

function ProposalCard({
  proposal,
  onConfirm,
  onCancel,
  busy,
}: {
  proposal: ToolProposal;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  // Translate the proposal into human-readable Chinese. The LLM produces
  // JSON; the UI makes it unambiguous so sales understands EXACTLY what
  // will happen before clicking Confirm.
  let summary = "";
  let confirmLabel = "Confirm";
  let dangerous = false;
  const a = proposal.action;
  if (a === "batch_send") {
    const limit = Number(proposal.limit) || 10;
    const explicitOverride = proposal.override === true;
    summary = explicitOverride
      ? `发 ${limit} 封 — 全部当 override 发 (会吃每日 200 额度)`
      : `发 ${limit} 封 — 优先非 gated; 不够的用 gated (override) 补`;
    confirmLabel = `发 ${limit} 封`;
    dangerous = true;
  } else if (a === "skip_lead") {
    summary = `把 lead ${String(proposal.lead_id ?? "?").slice(0, 8)} 标记为 skipped`;
    confirmLabel = "Skip";
  } else if (a === "flag_lead") {
    const sev = proposal.severity === "hard" ? "HARD (加入 blocklist)" : "soft";
    summary = `Flag lead ${String(proposal.lead_id ?? "?").slice(0, 8)} — type=${proposal.type} severity=${sev}`;
    confirmLabel = sev === "HARD (加入 blocklist)" ? "Block & skip" : "Flag";
    dangerous = sev.startsWith("HARD");
  } else if (a === "bulk_flag") {
    const ids = Array.isArray(proposal.lead_ids) ? proposal.lead_ids : [];
    summary = `批量 flag ${ids.length} 个 lead — type=${proposal.type} (soft only)`;
    confirmLabel = `Flag ${ids.length}`;
  } else if (a === "redraft_lead") {
    const dir = proposal.direction ? ` (方向: ${proposal.direction})` : "";
    summary = `重写 lead ${String(proposal.lead_id ?? "?").slice(0, 8)} 的草稿${dir}`;
    confirmLabel = "Redraft";
  } else if (a === "review_next") {
    summary = "打开 Review 模式查看下一个 ready lead";
    confirmLabel = "Go";
  } else {
    summary = `未知操作: ${a}`;
    confirmLabel = "Execute";
  }

  return (
    <div
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        padding: 10,
        borderRadius: 10,
        border: "1px solid " + (dangerous ? "#FCA5A5" : "#E5E7EB"),
        background: dangerous ? "#FEF2F2" : "#F9FAFB",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary, #6b7280)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Proposed action
      </div>
      <div style={{ fontSize: 13, color: "var(--text, #111827)" }}>{summary}</div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            fontSize: 12, padding: "5px 10px", border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 6, background: "transparent", cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          style={{
            fontSize: 12, padding: "5px 12px", border: 0, borderRadius: 6,
            background: dangerous ? "#DC2626" : "#6366F1",
            color: "white",
            cursor: busy ? "not-allowed" : "pointer",
            display: "inline-flex", alignItems: "center", gap: 4,
          }}
        >
          {busy ? <Loader2 style={{ width: 12, height: 12 }} className="spin" /> : <Check style={{ width: 12, height: 12 }} />}
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
