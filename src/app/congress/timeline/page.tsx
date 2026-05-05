// /congress/timeline — museum-wall view, Roosevelt-style.
//
// Single ink color (zinc). Typography-driven: serif body, mono numerals,
// sans labels in small caps. Three companies stack as horizontal lanes,
// each with a thin baseline + small unobtrusive marks. No lane colors,
// no conviction-color heatmap. Click any dot → drawer with the full
// meeting minutes (round-1 positions, round-2 attacks + rebuttals,
// synthesizer ranking).
"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import type { TimelinePayload, TimelineLane, TimelineDot, MinutesPosition, MinutesAttack, MeetingMinutes, InvestorTrack } from "@/app/api/congress/timeline/route";

const LANE_HEIGHT = 100;
const LEFT_RAIL_PX = 220;
const RIGHT_RAIL_PX = 96;
const TOP_AXIS_PX = 36;

const SERIF = `"Newsreader", "Source Serif Pro", "EB Garamond", Georgia, serif`;
const MONO = `ui-monospace, "SF Mono", "JetBrains Mono", monospace`;

export default function CongressTimelinePage() {
  const router = useRouter();
  const [data, setData] = useState<TimelinePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<{ lane: TimelineLane; dot: TimelineDot } | null>(null);

  const refresh = () => {
    setLoading(true);
    fetch("/api/congress/timeline")
      .then(async (r) => {
        if (r.status === 401) { router.replace("/login?next=/congress/timeline"); return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (d) setData(d); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [router]);

  if (loading && !data) return <FullLoader />;
  if (err || !data) return <div style={{ padding: 24, fontFamily: SERIF, fontSize: 14, color: "#52525b" }}>Couldn&apos;t load timeline{err ? `: ${err}` : ""}.</div>;
  if (data.lanes.length === 0) return <Empty />;

  return (
    // Cancel out .app-content's side + bottom padding so the museum wall
    // reaches the sidebar edge on the left and the viewport edge on the
    // right, with cream flowing edge-to-edge. The nav above stays in the
    // standard app vocabulary; only the wall itself opts into the
    // museum canvas.
    <div style={{
      margin: "0 -40px -48px",
      minHeight: "calc(100vh - 100px)",
      padding: "28px 40px 60px",
      background: "var(--card, #fafaf9)",
      color: "#18181b",
      fontFamily: SERIF,
    }}>
      <Plate data={data} />
      <Wall data={data} onSelect={(lane, dot) => setActive({ lane, dot })} />
      {active && <MinutesDrawer lane={active.lane} dot={active.dot} onClose={() => setActive(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  The "plate" — museum-style title plaque
// ─────────────────────────────────────────────────────────────

function Plate({ data }: { data: TimelinePayload }) {
  const start = new Date(data.range.start).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const end = new Date(data.range.end).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  return (
    <div style={{
      maxWidth: 720,
      marginBottom: 36,
    }}>
      <div style={{
        fontFamily: `ui-sans-serif, system-ui, -apple-system`,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: "#71717a",
        marginBottom: 10,
      }}>
        Hall of Congress · Permanent Exhibit
      </div>
      <h1 style={{
        margin: 0,
        fontFamily: SERIF,
        fontSize: 30,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        lineHeight: 1.15,
        color: "#18181b",
      }}>
        {data.lanes.length} companies, {data.investors.length} investors
      </h1>
      <p style={{
        margin: "8px 0 0",
        fontSize: 13.5,
        color: "#52525b",
        fontStyle: "italic",
        lineHeight: 1.6,
        maxWidth: 580,
      }}>
        From {start} to {end}. Each company runs its own deliberation; investors stake capital and revise conviction. What follows is the public record.
      </p>
      <InvestorPlaque investors={data.investors} />
    </div>
  );
}

function InvestorPlaque({ investors }: { investors: InvestorTrack[] }) {
  return (
    <div style={{
      marginTop: 22,
      paddingTop: 14,
      borderTop: "0.5px solid #d4d4d8",
      display: "flex",
      gap: 32,
      flexWrap: "wrap",
    }}>
      {investors.map((inv) => {
        const start = inv.trajectory[0]?.balance ?? inv.current_balance;
        const delta = inv.current_balance - start;
        return (
          <div key={inv.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "#a1a1aa", fontFamily: "ui-sans-serif, system-ui" }}>
              {inv.name}
            </span>
            <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontSize: 15, color: "#18181b", fontWeight: 500 }}>
              {inv.current_balance.toFixed(0)} pts
            </span>
            <span style={{ fontSize: 11, color: delta > 0 ? "#16a34a" : delta < 0 ? "#a16207" : "#71717a", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              {delta > 0 ? "+" : ""}{delta.toFixed(0)} since funding · {inv.style}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  The wall
// ─────────────────────────────────────────────────────────────

function Wall({ data, onSelect }: { data: TimelinePayload; onSelect: (lane: TimelineLane, dot: TimelineDot) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const x0 = new Date(data.range.start).getTime();
  const x1 = new Date(data.range.end).getTime();
  const span = Math.max(1, x1 - x0);
  const trackWidth = Math.max(0, width - LEFT_RAIL_PX - RIGHT_RAIL_PX);

  // Tick marks: month starts as named labels; intermediate weeks as silent ticks.
  const ticks = useMemo(() => {
    const out: { ms: number; label: string | null }[] = [];
    const cursor = new Date(x0);
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCDate(1);
    while (cursor.getTime() <= x1) {
      out.push({
        ms: cursor.getTime(),
        label: cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return out;
  }, [x0, x1]);

  const todayMs = Date.now();

  return (
    <div ref={containerRef} style={{ borderTop: "1.5px solid #18181b", paddingTop: 22 }}>
      {/* Time axis */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `${LEFT_RAIL_PX}px 1fr ${RIGHT_RAIL_PX}px`,
        marginBottom: 8,
      }}>
        <div />
        <div style={{ position: "relative", height: TOP_AXIS_PX }}>
          {ticks.map((t, i) => {
            const left = ((t.ms - x0) / span) * 100;
            return (
              <div key={i} style={{ position: "absolute", left: `${left}%`, top: 0, bottom: 0 }}>
                <div style={{ height: 8, width: 0.5, background: "#a1a1aa", marginLeft: 0 }} />
                <div style={{
                  marginTop: 4,
                  fontSize: 11,
                  fontStyle: "italic",
                  color: "#52525b",
                  whiteSpace: "nowrap",
                }}>
                  {t.label}
                </div>
              </div>
            );
          })}
        </div>
        <div />
      </div>

      {/* Cross-lane today line + weight flips */}
      <div style={{ position: "relative" }}>
        {todayMs > x0 && todayMs < x1 && (
          <div style={{
            position: "absolute",
            left: `${LEFT_RAIL_PX + ((todayMs - x0) / span) * trackWidth}px`,
            top: 0, bottom: 0, width: 0,
            borderLeft: "0.5px solid #18181b",
            zIndex: 4,
            pointerEvents: "none",
          }}>
            <div style={{
              position: "absolute",
              top: -22,
              left: 4,
              fontSize: 10,
              fontStyle: "italic",
              color: "#18181b",
              background: "var(--card, #fafaf9)",
              padding: "0 4px",
              whiteSpace: "nowrap",
            }}>today</div>
          </div>
        )}

        {data.weight_flips.map((f, i) => {
          const ms = new Date(f.at).getTime();
          if (ms < x0 || ms > x1) return null;
          const leftPx = LEFT_RAIL_PX + ((ms - x0) / span) * trackWidth;
          return (
            <div key={i} title={f.rationale} style={{
              position: "absolute", left: `${leftPx}px`, top: 0, bottom: 0,
              width: 0, borderLeft: "0.5px dashed #71717a",
              zIndex: 3, pointerEvents: "none",
            }}>
              <div style={{
                position: "absolute", top: 6, left: 6,
                fontSize: 9.5, fontStyle: "italic", color: "#52525b",
                background: "var(--card, #fafaf9)", padding: "0 4px",
                whiteSpace: "nowrap",
              }}>weights v{f.version}</div>
            </div>
          );
        })}

        {data.lanes.map((lane, i) => (
          <Lane
            key={lane.company_id}
            lane={lane}
            x0={x0}
            span={span}
            trackWidth={trackWidth}
            isLast={i === data.lanes.length - 1}
            onSelect={(d) => onSelect(lane, d)}
          />
        ))}
      </div>
    </div>
  );
}

function Lane({ lane, x0, span, trackWidth, isLast, onSelect }: {
  lane: TimelineLane; x0: number; span: number; trackWidth: number; isLast: boolean;
  onSelect: (d: TimelineDot) => void;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `${LEFT_RAIL_PX}px 1fr ${RIGHT_RAIL_PX}px`,
      borderBottom: isLast ? "1.5px solid #18181b" : "0.5px solid #d4d4d8",
      minHeight: LANE_HEIGHT,
      opacity: lane.active ? 1 : 0.55,
    }}>
      {/* Left rail — name + thesis in serif */}
      <div style={{ padding: "20px 20px 20px 0" }}>
        <div style={{
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: "-0.005em",
          color: "#18181b",
          marginBottom: 4,
        }}>
          {lane.company_name}
          {!lane.active && <span style={{ fontSize: 10, marginLeft: 8, fontStyle: "italic", color: "#a16207" }}>cut</span>}
        </div>
        {lane.thesis && (
          <div style={{
            fontSize: 12.5,
            fontStyle: "italic",
            color: "#52525b",
            lineHeight: 1.55,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            “{lane.thesis}”
          </div>
        )}
      </div>

      {/* Track */}
      <div style={{ position: "relative", padding: "20px 0" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 0.5, background: "#a1a1aa" }} />
        {lane.dots.map((d) => {
          const ms = new Date(d.at).getTime();
          const leftPct = ((ms - x0) / span) * 100;
          if (leftPct < 0 || leftPct > 100) return null;
          return <DotMark key={d.id} dot={d} leftPct={leftPct} onClick={() => onSelect(d)} />;
        })}
      </div>

      {/* Right rail — record */}
      <div style={{
        padding: "20px 0 20px 16px",
        display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end",
        textAlign: "right",
      }}>
        <div style={{
          fontFamily: MONO, fontVariantNumeric: "tabular-nums",
          fontSize: 14, color: "#18181b",
        }}>
          {lane.contracts_hit}–{lane.contracts_miss}
        </div>
        <div style={{ fontSize: 9.5, fontStyle: "italic", color: "#71717a", letterSpacing: "0.04em" }}>
          hit · miss
        </div>
        {lane.current_conviction != null && (
          <div style={{ marginTop: 4, fontSize: 10.5, color: "#52525b" }}>
            conviction <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{lane.current_conviction.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DotMark({ dot, leftPct, onClick }: { dot: TimelineDot; leftPct: number; onClick: () => void }) {
  const isMeeting = dot.kind === "weekly" || dot.kind === "monthly" || dot.kind === "quarterly";
  const isFunded = dot.kind === "funded";
  const isCut = dot.kind === "cut";
  const isConv = dot.kind === "conviction";

  // Roosevelt-style marks: small filled or hollow circles in ink.
  // Hit = filled circle. Miss = hollow circle. Funded = small flag/triangle.
  // Cut = X. Conviction = even smaller hairline tick.
  const size =
    isFunded ? 12 :
    dot.kind === "monthly"   ? 11 :
    dot.kind === "quarterly" ? 11 :
    isCut ? 11 :
    isConv ? 5 :
    9;

  const filled = dot.outcome === "hit" || isFunded;
  const ink = "#18181b";

  return (
    <button
      type="button"
      onClick={onClick}
      title={dot.label}
      style={{
        position: "absolute",
        left: `${leftPct}%`,
        top: "50%",
        transform: "translate(-50%, -50%)",
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        zIndex: isFunded ? 3 : 2,
      }}
    >
      {/* The mark itself */}
      {isCut ? (
        <svg width={size} height={size} style={{ display: "block" }}>
          <line x1="1" y1="1" x2={size - 1} y2={size - 1} stroke={ink} strokeWidth="1.4" />
          <line x1={size - 1} y1="1" x2="1" y2={size - 1} stroke={ink} strokeWidth="1.4" />
        </svg>
      ) : isFunded ? (
        // Triangle facing right, like a flag.
        <svg width={size} height={size} style={{ display: "block" }}>
          <polygon points={`1,1 ${size - 1},${size / 2} 1,${size - 1}`} fill={ink} />
        </svg>
      ) : (
        <span style={{
          width: size, height: size,
          borderRadius: "50%",
          background: filled ? ink : "var(--card, #fafaf9)",
          border: `1px solid ${ink}`,
          display: "block",
        }} />
      )}

      {/* Inline date + outcome below the mark for meetings only */}
      {isMeeting && dot.inline && (
        <span style={{
          position: "absolute",
          top: `${size + 6}px`,
          fontFamily: MONO,
          fontVariantNumeric: "tabular-nums",
          fontSize: 9.5,
          color: dot.outcome === "miss" ? "#a16207" : "#52525b",
          whiteSpace: "nowrap",
        }}>
          {dot.inline}
        </span>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
//  Minutes drawer
// ─────────────────────────────────────────────────────────────

function MinutesDrawer({ lane, dot, onClose }: { lane: TimelineLane; dot: TimelineDot; onClose: () => void }) {
  const m = dot.minutes;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(24, 24, 27, 0.32)", zIndex: 50,
      display: "flex", justifyContent: "flex-end",
    }}>
      <aside onClick={(e) => e.stopPropagation()} style={{
        width: "min(580px, 92vw)", height: "100vh",
        background: "var(--card, #fafaf9)", borderLeft: "1px solid #18181b",
        padding: "32px 36px 40px", overflowY: "auto",
        fontFamily: SERIF, color: "#18181b",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div style={{
            fontFamily: "ui-sans-serif, system-ui",
            fontSize: 10.5, fontWeight: 600,
            letterSpacing: "0.14em", textTransform: "uppercase",
            color: "#71717a",
          }}>
            {lane.company_name} · {dot.kind === "monthly" ? "Monthly Strategic" : dot.kind === "quarterly" ? "Quarterly Postmortem" : dot.kind === "weekly" ? "Weekly Tactical" : dot.kind === "funded" ? "Founding Note" : dot.kind === "cut" ? "Dissolution" : "Note"}
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: 0, cursor: "pointer", padding: 4, color: "#71717a" }}>
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <h2 style={{
          margin: "0 0 6px",
          fontFamily: SERIF,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          lineHeight: 1.25,
        }}>
          {dot.story.headline}
        </h2>
        <div style={{ fontSize: 11.5, color: "#71717a", marginBottom: 24, fontStyle: "italic", fontFamily: SERIF }}>
          {new Date(dot.at).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        </div>

        {/* Status line — hit/miss/etc */}
        {dot.story.fields.length > 0 && (
          <div style={{
            display: "flex", flexWrap: "wrap", gap: "4px 18px",
            paddingBottom: 18, marginBottom: 22,
            borderBottom: "0.5px solid #d4d4d8",
            fontSize: 12,
          }}>
            {dot.story.fields.map((f, i) => (
              <span key={i} style={{ color: "#52525b" }}>
                <span style={{
                  fontFamily: "ui-sans-serif, system-ui",
                  fontSize: 9.5,
                  fontWeight: 600,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "#a1a1aa",
                  marginRight: 6,
                }}>{f.label}</span>
                <span style={{ fontFamily: typeof f.value === "number" || /^[\d./%]+$/.test(String(f.value)) ? MONO : SERIF, fontVariantNumeric: "tabular-nums", color: "#18181b" }}>
                  {f.value}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Full minutes if this is a deliberation */}
        {m ? <Minutes m={m} /> : (
          dot.story.body && (
            <p style={{ fontSize: 14.5, lineHeight: 1.7, color: "#3f3f46", margin: 0 }}>
              {dot.story.body}
            </p>
          )
        )}
      </aside>
    </div>
  );
}

const PERSONA_LABEL: Record<string, string> = {
  data_analyst: "Data Analyst",
  copywriter: "Copywriter",
  academic_proxy: "Academic Proxy",
  sales_director: "Sales Director",
  psychologist: "Psychologist",
  adversary: "Adversary",
  synthesizer: "Synthesizer",
};

function Minutes({ m }: { m: MeetingMinutes }) {
  // VC-memo layout: Recommendation up top (the bet, with conviction).
  // Then: The case (round-1 positions distilled by role), The bear case
  // (adversary, steelmanned, with rebuttal), and the Synthesizer's
  // closing — what they'll watch, what would change their mind.
  const recColor =
    m.recommendation === "approve" ? "#16a34a" :
    m.recommendation === "reject"  ? "#dc2626" :
    m.recommendation === "defer"   ? "#a16207" : "#52525b";

  return (
    <div>
      {/* Recommendation header — the bet stated plainly */}
      {(m.recommendation || m.confidence != null) && (
        <div style={{
          marginBottom: 24,
          paddingBottom: 18,
          borderBottom: "0.5px solid #d4d4d8",
        }}>
          <div style={{
            fontFamily: "ui-sans-serif, system-ui",
            fontSize: 9.5, fontWeight: 600,
            letterSpacing: "0.14em", textTransform: "uppercase",
            color: "#a1a1aa", marginBottom: 6,
          }}>Recommendation</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{
              fontFamily: SERIF, fontSize: 19, fontWeight: 600,
              color: recColor, letterSpacing: "-0.005em",
              textTransform: "capitalize",
            }}>
              {m.recommendation ?? "—"}
            </span>
            {m.confidence != null && (
              <span style={{
                fontFamily: SERIF, fontStyle: "italic",
                fontSize: 13, color: "#52525b",
              }}>
                conviction <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#18181b" }}>{(m.confidence * 100).toFixed(0)}%</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* The case — round-1 positions, presented as analytical paragraphs */}
      {m.positions.length > 0 && (
        <>
          <SectionLabel n="I" title="The case" subtitle="What each lens sees in the evidence" />
          {m.positions.map((p, i) => <PositionParagraph key={i} pos={p} />)}
        </>
      )}

      {/* The bear case — adversary, with rebuttal */}
      {m.attacks.length > 0 && (
        <>
          <SectionLabel n="II" title="The bear case" subtitle="Strongest objection, steelmanned" />
          {m.attacks.map((a, i) => <AttackBlock key={i} attack={a} />)}
        </>
      )}

      {/* Synthesizer — what we'll watch, what would change our mind */}
      {m.synthesizer && (
        <>
          <SectionLabel n="III" title="Closing" subtitle="What we will watch · what would change our mind" />
          <p style={{
            margin: "0 0 10px",
            fontSize: 14.5,
            lineHeight: 1.75,
            color: "#18181b",
            fontFamily: SERIF,
          }}>
            {m.synthesizer}
          </p>
        </>
      )}
    </div>
  );
}

function SectionLabel({ n, title, subtitle }: { n: string; title: string; subtitle?: string }) {
  return (
    <div style={{ marginTop: 26, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{
          fontFamily: SERIF, fontStyle: "italic",
          fontSize: 14, color: "#a1a1aa",
        }}>{n}.</span>
        <span style={{
          fontFamily: SERIF, fontSize: 16, fontWeight: 600,
          color: "#18181b", letterSpacing: "-0.005em",
        }}>{title}</span>
      </div>
      {subtitle && (
        <div style={{
          marginTop: 2, marginLeft: 22,
          fontFamily: SERIF, fontStyle: "italic",
          fontSize: 11.5, color: "#71717a",
        }}>{subtitle}</div>
      )}
    </div>
  );
}

function PositionParagraph({ pos }: { pos: MinutesPosition }) {
  return (
    <div style={{ marginBottom: 14, display: "flex", gap: 14 }}>
      <span style={{
        flexShrink: 0,
        width: 110,
        fontFamily: "ui-sans-serif, system-ui",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "#71717a",
        paddingTop: 3,
      }}>
        {PERSONA_LABEL[pos.persona] ?? pos.persona}
      </span>
      <p style={{
        margin: 0,
        fontSize: 14.5,
        lineHeight: 1.7,
        color: "#3f3f46",
        fontFamily: SERIF,
      }}>
        {pos.message}
      </p>
    </div>
  );
}

function AttackBlock({ attack }: { attack: MinutesAttack }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 14 }}>
        <span style={{
          flexShrink: 0,
          width: 110,
          fontFamily: "ui-sans-serif, system-ui",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#71717a",
          paddingTop: 3,
        }}>
          Adversary
        </span>
        <p style={{
          margin: 0,
          fontSize: 14.5,
          lineHeight: 1.7,
          color: "#3f3f46",
          fontFamily: SERIF,
          fontStyle: "italic",
        }}>
          <span style={{ fontStyle: "normal", fontSize: 12, color: "#71717a" }}>
            attacks {PERSONA_LABEL[attack.attacks_persona] ?? attack.attacks_persona} —{" "}
          </span>
          {attack.message}
        </p>
      </div>

      {attack.rebuttal && (
        <div style={{ marginTop: 8, marginLeft: 124, display: "flex", gap: 14 }}>
          <span style={{
            flexShrink: 0,
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: 12,
            color: "#71717a",
            paddingTop: 3,
          }}>
            {PERSONA_LABEL[attack.rebuttal.by_persona] ?? attack.rebuttal.by_persona} responds —
          </span>
          <p style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.65,
            color: "#52525b",
            fontFamily: SERIF,
          }}>
            {attack.rebuttal.message}
          </p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  Misc
// ─────────────────────────────────────────────────────────────

function FullLoader() {
  return (
    <div style={{ padding: "120px 0", textAlign: "center", color: "#71717a" }}>
      <Loader2 className="h-5 w-5 animate-spin" style={{ display: "inline-block" }} />
    </div>
  );
}

function Empty() {
  return (
    <div style={{ padding: "60px 24px", textAlign: "center", maxWidth: 480, margin: "60px auto", fontFamily: SERIF }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: "#3f3f46", marginBottom: 8 }}>The hall is empty.</div>
      <p style={{ fontSize: 13, color: "#71717a", lineHeight: 1.6, fontStyle: "italic" }}>
        Fund a company at <code>/bench/sim</code> and run a few weeks before the wall fills out.
      </p>
    </div>
  );
}
