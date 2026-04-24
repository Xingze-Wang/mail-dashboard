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
import { AgentSplitView } from "./agent-split-view";

/**
 * Cute robot avatar — pure SVG, no deps. Three moods drive CSS-only
 * animations keyed by data-mood on the host button:
 *
 *   idle   — soft blink every few seconds (alive, but quiet)
 *   wave   — right arm arcs once (fires when daily opener is ready)
 *   peek   — body pops UP out of the button, arm waves slowly, then
 *            settles back into the circle (fires when a signal-based
 *            chime-in is pending; wants attention without being a toast)
 *
 * Rendered inside the floating round button. The button has
 * `overflow: visible` so `peek` can translate the robot upward
 * past the circle's top edge. Colors stay on-brand with the existing
 * indigo→pink gradient — robot is white with subtle shading.
 */
function CuteRobot({ mood }: { mood: "idle" | "wave" | "peek" | "alert" }) {
  return (
    <svg
      data-mood={mood}
      viewBox="0 0 48 48"
      width="34"
      height="34"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block", overflow: "visible" }}
      aria-hidden="true"
    >
      {/* Subtle drop shadow under the robot so it reads as sitting
          INSIDE the button rather than floating flat on the gradient. */}
      <defs>
        <filter id="robot-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="0.6" />
          <feOffset dx="0" dy="0.6" result="off" />
          <feComponentTransfer><feFuncA type="linear" slope="0.25" /></feComponentTransfer>
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* body group — translates up on peek, rocks slightly on wave */}
      <g className="robot-body" filter="url(#robot-shadow)">
        {/* antenna — with gap above head */}
        <line x1="24" y1="4.5" x2="24" y2="9" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="24" cy="3" r="2" fill="#fde68a" />

        {/* head — slightly taller, deeper rounding for a softer read */}
        <rect x="10" y="10" width="28" height="20" rx="8" ry="8" fill="white" />
        {/* head top highlight — a thin lighter strip so the head doesn't
            read as a flat white blob against the gradient */}
        <rect x="12" y="11.5" width="24" height="3" rx="1.5" ry="1.5" fill="#f5f3ff" opacity="0.9" />

        {/* eyes — bigger + set lower on the face (classic "cute" ratio).
            Each eye has a white catchlight so they feel alive. */}
        <g className="robot-eye left">
          <circle cx="18.5" cy="21" r="3" fill="#1e1b4b" />
          <circle cx="19.4" cy="20.1" r="0.9" fill="white" />
        </g>
        <g className="robot-eye right">
          <circle cx="29.5" cy="21" r="3" fill="#1e1b4b" />
          <circle cx="30.4" cy="20.1" r="0.9" fill="white" />
        </g>

        {/* cheeks */}
        <circle cx="14" cy="25" r="1.6" fill="#fbcfe8" />
        <circle cx="34" cy="25" r="1.6" fill="#fbcfe8" />

        {/* smile — wider arc, thicker stroke, shows up at 32px */}
        <path d="M20.5 26.2 Q24 28.8 27.5 26.2" stroke="#1e1b4b" strokeWidth="1.6" fill="none" strokeLinecap="round" />

        {/* body */}
        <rect x="14" y="30" width="20" height="11" rx="3.5" ry="3.5" fill="white" />
        {/* status light on chest — pulses subtly via CSS */}
        <circle className="robot-chest-light" cx="24" cy="35.5" r="1.6" fill="#ec4899" />

        {/* left arm (static, cradled slightly against body) */}
        <rect x="8.5" y="30.5" width="4" height="9" rx="2" ry="2" fill="white" />

        {/* right arm — animated on wave/peek */}
        <g className="robot-arm-right">
          <rect x="35.5" y="30.5" width="4" height="9" rx="2" ry="2" fill="white" />
          <circle cx="37.5" cy="40.5" r="2" fill="white" />
        </g>
      </g>
    </svg>
  );
}

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
  // Pending chime-in — proactive, signal-based message from the
  // /api/cron/proactive-signals watcher. When present, seeded as the
  // FIRST assistant message (above the opener). Cleared server-side
  // on read so it fires once — if the cron re-detects the signal
  // tomorrow, it comes back.
  const [pendingChimeIn, setPendingChimeIn] = useState<{ type: string; message: string } | null>(null);
  // Split-view data, populated when the helper's open_split_view action
  // is confirmed. Outlives the chat modal so the rep can close the
  // chat without losing the viewer. Cleared on the overlay's close.
  // Listens for a 'helper:open-split-view' CustomEvent so the inner
  // HelpModal can dispatch without us passing callbacks through React.
  interface SplitViewData {
    leadId: string;
    title: string;
    authors: string | null;
    pdfUrl: string | null;
    abstract: string | null;
    authorName: string | null;
    authorEmail: string | null;
    draftSubject: string | null;
    draftHtml: string | null;
    status: string;
  }
  const [splitView, setSplitView] = useState<SplitViewData | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent).detail as SplitViewData | undefined;
      if (d && typeof d.leadId === "string") setSplitView(d);
    };
    window.addEventListener("helper:open-split-view", onOpen);
    return () => window.removeEventListener("helper:open-split-view", onOpen);
  }, []);
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

  // Fetch the daily opener + pending chime-in in parallel. The opener
  // is cadence-driven (once per Beijing day); the chime-in is signal-
  // driven (a cron watcher wrote it when a rule tripped). Both seed
  // the chat on open — chime-in first if present, then opener.
  useEffect(() => {
    if (pathname.startsWith("/login")) return;
    let cancelled = false;
    (async () => {
      try {
        const [openR, chimeR] = await Promise.all([
          fetch("/api/help/opening"),
          fetch("/api/help/chime-in"),
        ]);
        if (openR.ok) {
          const d = await openR.json();
          if (!cancelled && !d.skip && typeof d.greeting === "string") {
            setPendingOpener(d.greeting);
          }
        }
        if (chimeR.ok) {
          const d = await chimeR.json();
          if (!cancelled && d.chimeIn && typeof d.chimeIn.message === "string") {
            setPendingChimeIn({ type: d.chimeIn.type, message: d.chimeIn.message });
          }
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

  // Brand-typo alert — surfaces as a one-shot "alert" mood on the
  // robot + a short toast. Listens for 'brand-typo' dispatched by
  // ReviewPane's brand-lint watcher. Auto-clears after 3s so the
  // robot returns to its prior mood.
  const [brandAlert, setBrandAlert] = useState<{ found: string; expected: string; note?: string } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onTypo = (e: Event) => {
      const hit = (e as CustomEvent).detail as { found: string; expected: string; note?: string } | undefined;
      if (!hit) return;
      setBrandAlert({ found: hit.found, expected: hit.expected, note: hit.note });
      setTimeout(() => setBrandAlert(null), 3500);
    };
    window.addEventListener("brand-typo", onTypo);
    return () => window.removeEventListener("brand-typo", onTypo);
  }, []);

  // Robot mood drives the CSS animation. alert > peek > wave > idle.
  // Alert when a brand-typo was just dispatched (wave-and-warn).
  // Peek when a signal-based chime-in is pending (wants attention).
  // Wave when a daily opener is ready but no chime-in (friendly hi).
  // Idle otherwise.
  const robotMood: "idle" | "wave" | "peek" | "alert" = brandAlert
    ? "alert"
    : pendingChimeIn
      ? "peek"
      : pendingOpener
        ? "wave"
        : "idle";

  return (
    <>
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Sales Helper — drag me anywhere, click to ask"
        data-robot-mood={robotMood}
        className="help-bot-button"
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
          // overflow: visible so `peek` can translate the robot up past
          // the button's top edge without getting clipped.
          overflow: "visible",
        }}
      >
        <CuteRobot mood={robotMood} />
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

      {/* Brand-typo toast — pops next to the robot when ReviewPane's
          brand-lint watcher spots a disallowed variant. Intentionally
          lightweight: no action buttons, just the correction. Auto-
          dismisses after 3.5s (same timer as the 'alert' mood). */}
      {brandAlert && (
        <div
          style={{
            position: "fixed",
            bottom: pos.y + 8,
            right: pos.x + 64,
            zIndex: 62,
            background: "#FEF2F2",
            color: "#991B1B",
            borderRadius: 12,
            padding: "10px 14px",
            maxWidth: 300,
            fontSize: 12.5,
            lineHeight: 1.45,
            boxShadow: "0 8px 24px rgba(220,38,38,0.18)",
            border: "1px solid #FCA5A5",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              「{brandAlert.found}」 → 「{brandAlert.expected}」
            </div>
            {brandAlert.note && (
              <div style={{ fontSize: 11.5, color: "#7F1D1D", opacity: 0.85 }}>{brandAlert.note}</div>
            )}
          </div>
          <button
            onClick={() => setBrandAlert(null)}
            title="Dismiss"
            style={{ background: "transparent", border: 0, color: "#991B1B", cursor: "pointer", padding: 0, lineHeight: 0, opacity: 0.6 }}
          >
            <X style={{ width: 13, height: 13 }} />
          </button>
        </div>
      )}

      {open && (
        <HelpModal
          pathname={pathname}
          onClose={() => setOpen(false)}
          initialSeed={pendingOpener}
          chimeIn={pendingChimeIn}
          onConsumeSeed={() => {
            setPendingOpener(null);
            setPendingChimeIn(null);
          }}
        />
      )}

      {/* Agent-conjured split-view. Mounts above everything; closes
          on Esc or the X button. Independent of the chat modal so the
          rep can dismiss the chat and keep reading/editing. */}
      {splitView && (
        <AgentSplitView data={splitView} onClose={() => setSplitView(null)} />
      )}
    </>
  );
}

function HelpModal({
  pathname,
  onClose,
  initialSeed,
  chimeIn,
  onConsumeSeed,
}: {
  pathname: string;
  onClose: () => void;
  initialSeed?: string | null;
  chimeIn?: { type: string; message: string } | null;
  onConsumeSeed?: () => void;
}) {
  // Keep currentLead in sync with the paper the rep is actually
  // looking at. Previously this was a one-shot read on modal mount,
  // so if sales J/Ks through leads in ReviewPane while the helper
  // is open, the LLM kept thinking they were asking about the
  // original paper — answers about "this paper" drifted.
  const [currentLead, setCurrentLead] = useState<CurrentReviewLead | null>(() => {
    if (typeof window === "undefined") return null;
    return window.__currentReviewLead ?? null;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => {
      const next = window.__currentReviewLead ?? null;
      setCurrentLead((prev) => {
        if ((prev?.id ?? null) === (next?.id ?? null)) return prev;
        return next;
      });
    };
    // 1s poll is cheap (identity check + setState no-op when unchanged)
    // and matches the same cadence used for the review-linger nudge.
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, []);

  // Seed chime-in (proactive signal) first, then daily opener. Both
  // get their own message bubble so the rep can see they're distinct
  // voices: the chime-in is "I noticed something", the opener is
  // "here's today's status". Seeding as assistant messages also means
  // the rep can answer either directly and the LLM sees the full
  // thread context.
  const [messages, setMessages] = useState<Msg[]>(() => {
    const seeds: Msg[] = [];
    const now = Date.now();
    if (chimeIn?.message) {
      seeds.push({ id: now, role: "assistant", text: chimeIn.message });
    }
    if (initialSeed) {
      seeds.push({ id: now + 1, role: "assistant", text: initialSeed });
    }
    return seeds;
  });
  useEffect(() => {
    if ((initialSeed || chimeIn) && onConsumeSeed) onConsumeSeed();
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
  // In-flight guard against double-create races. Two rapid sends both
  // enter ensureConversation before conversationId has settled from the
  // first fetch; without this ref each would POST its own new row and
  // the history panel would show duplicate threads. The ref holds the
  // in-flight Promise so the second caller awaits the same result.
  const convInFlightRef = useRef<Promise<string | null> | null>(null);

  // Lazy-create a conversation for persistence. One unified chat now.
  const ensureConversation = useCallback(async (firstMessage: string): Promise<string | null> => {
    if (conversationId) return conversationId;
    if (convInFlightRef.current) return convInFlightRef.current;
    const inFlight = (async (): Promise<string | null> => {
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
    })();
    convInFlightRef.current = inFlight;
    try {
      return await inFlight;
    } finally {
      convInFlightRef.current = null;
    }
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
      // open_split_view — server returned lead data; the outer
      // HelpBot listens for this event and mounts the overlay.
      if (r.ok && proposal.action === "open_split_view") {
        const payload = (d.detail as { openSplitView?: unknown } | undefined)?.openSplitView;
        if (payload && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("helper:open-split-view", { detail: payload }));
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
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 14px 4px", display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text, #111827)" }}>
                {currentLead ? "在看这篇 paper." : "随便问."}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-tertiary, #9ca3af)", lineHeight: 1.55 }}>
                {currentLead ? "想读懂 / 想发 / 想改草稿都行." : "问 app 操作, 查数字, 发邮件."}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 4 }}>
                {(currentLead ? PAPER_SUGGESTIONS : SALES_SUGGESTIONS).slice(0, 4).map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    style={{
                      fontSize: 12.5,
                      textAlign: "left",
                      padding: "8px 12px",
                      background: "var(--card, #fff)",
                      border: "1px solid var(--border, #e5e7eb)",
                      borderRadius: 8,
                      cursor: "pointer",
                      color: "var(--text-secondary, #4b5563)",
                      transition: "background 120ms, border-color 120ms",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "#f9fafb"; e.currentTarget.style.borderColor = "#d1d5db"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--card, #fff)"; e.currentTarget.style.borderColor = "var(--border, #e5e7eb)"; }}
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
                    maxWidth: "88%",
                    padding: m.role === "user" ? "7px 11px" : "9px 12px",
                    fontSize: 13,
                    lineHeight: 1.55,
                    borderRadius: 12,
                    background: m.role === "user" ? "#6366F1" : "var(--bg, #f5f6f8)",
                    color: m.role === "user" ? "white" : "var(--text, #111827)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    border: m.role === "user" ? "none" : "1px solid var(--border-light, #eef0f3)",
                  }}
                >
                  {renderMessageContent(m.text)}
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
            <div style={{ alignSelf: "flex-start", padding: "6px 10px", display: "inline-flex", gap: 4, alignItems: "center" }}>
              <span className="helper-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--text-tertiary, #9ca3af)", animationDelay: "0ms" }} />
              <span className="helper-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--text-tertiary, #9ca3af)", animationDelay: "150ms" }} />
              <span className="helper-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--text-tertiary, #9ca3af)", animationDelay: "300ms" }} />
            </div>
          )}
          {err && (
            <div style={{ alignSelf: "flex-start", padding: "8px 10px", fontSize: 12, color: "#dc2626", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6 }}>
              {err}
            </div>
          )}
        </div>

        {/* input */}
        <div style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--border-light, #f3f4f6)", display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && !busy) send(input);
              }
            }}
            placeholder="问问题, 或让我做事…"
            rows={2}
            style={{
              flex: 1,
              padding: "8px 11px",
              fontSize: 13,
              lineHeight: 1.5,
              border: "1px solid var(--border, #e5e7eb)",
              borderRadius: 8,
              background: "var(--card, #fff)",
              color: "var(--text, #111827)",
              resize: "none",
              boxSizing: "border-box",
              outline: "none",
              fontFamily: "inherit",
              transition: "border-color 120ms",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "#6366F1"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border, #e5e7eb)"; }}
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            title={input.trim() ? "Send (Enter)" : "Type a message"}
            style={{
              width: 38,
              height: 38,
              flexShrink: 0,
              background: input.trim() && !busy ? "#6366F1" : "var(--bg, #f3f4f6)",
              color: input.trim() && !busy ? "white" : "var(--text-tertiary, #9ca3af)",
              border: 0,
              borderRadius: 8,
              cursor: input.trim() && !busy ? "pointer" : "not-allowed",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 120ms",
            }}
          >
            {busy ? <Loader2 style={{ width: 14, height: 14 }} className="spin" /> : <Send style={{ width: 14, height: 14 }} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function renderMessageContent(text: string): React.ReactNode {
  const paras = text.split(/\n{2,}/);
  return paras.map((para, pi) => {
    const lines = para.split("\n");
    return (
      <div key={pi} style={{ marginTop: pi === 0 ? 0 : 8 }}>
        {lines.map((line, li) => (
          <div key={li}>{renderInline(line)}</div>
        ))}
      </div>
    );
  });
}

function renderInline(line: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let i = 0;
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let match: RegExpExecArray | null = pattern.exec(line);
  while (match) {
    if (match.index > i) out.push(line.slice(i, match.index));
    if (match[1] !== undefined) {
      out.push(<strong key={`b${match.index}`}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      out.push(
        <code
          key={`c${match.index}`}
          style={{ fontFamily: "ui-monospace, monospace", background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 4, fontSize: "90%" }}
        >
          {match[2]}
        </code>,
      );
    }
    i = pattern.lastIndex;
    match = pattern.exec(line);
  }
  if (i < line.length) out.push(line.slice(i));
  return out.length === 0 ? line : out;
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
