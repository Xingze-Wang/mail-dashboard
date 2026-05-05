// /congress/about — annotated diagram of the four-loop congress.
// Standard app vocabulary: section-card containers, sans-serif body,
// CSS variables for color. Same visual language as Overview/Pipeline.

type Persona = {
  initials: string;
  label: string;
  role: string;
  hue: "neutral" | "adversary" | "synthesizer" | "data" | "voice";
};

type Loop = {
  cadence: string;
  label: string;
  one_line: string;
  outputs: string;
  personas: Persona[];
};

const LOOPS: Loop[] = [
  {
    cadence: "Daily",
    label: "JITR · Just-In-Time Ratifier",
    one_line: "Detects drift between AI drafts and the rep's edits; offers a one-line patch back.",
    outputs: "→ accepted patches feed Weekly evidence",
    personas: [
      { initials: "DA", label: "Drift Analyst", role: "scans rep edits, finds patterns", hue: "data" },
      { initials: "AD", label: "Adversary", role: "would this patch break anything?", hue: "adversary" },
      { initials: "SY", label: "Synthesizer", role: "writes the offer card the rep sees", hue: "synthesizer" },
    ],
  },
  {
    cadence: "Weekly",
    label: "Tactical Congress",
    one_line: "Reads weekly evidence pack. Produces ranked proposals for content / routing / pacing changes.",
    outputs: "→ ranked proposals enter editor → admin gates · approved ones inform Monthly",
    personas: [
      { initials: "DA", label: "Data Analyst", role: "anchors arguments in metrics", hue: "data" },
      { initials: "CW", label: "Copywriter", role: "drafts variants, judges tone", hue: "voice" },
      { initials: "AP", label: "Academic Proxy", role: "speaks for researchers", hue: "voice" },
      { initials: "SD", label: "Sales Director", role: "owns conversion pressure", hue: "voice" },
      { initials: "PS", label: "Psychologist", role: "trust + cognitive load", hue: "voice" },
      { initials: "AD", label: "Adversary", role: "round-2 attack on every proposal", hue: "adversary" },
      { initials: "SY", label: "Synthesizer", role: "ranks the week's recommendations", hue: "synthesizer" },
    ],
  },
  {
    cadence: "Monthly",
    label: "Strategic Congress",
    one_line: "Reviews 90-day trends + the quarter's approved proposals. Issues directives that constrain next Weekly.",
    outputs: "→ active_directives injected into next Weekly's prompt · summary feeds Quarterly",
    personas: [
      { initials: "HI", label: "Head of Insights", role: "90-day trend reader", hue: "data" },
      { initials: "FE", label: "Field Exec", role: "rep-floor execution feasibility", hue: "voice" },
      { initials: "CA", label: "Chief Academic", role: "institutional reputation risk", hue: "voice" },
      { initials: "PS", label: "Psychologist", role: "systemic trust drift", hue: "voice" },
      { initials: "AD", label: "Adversary", role: "attacks monthly priorities", hue: "adversary" },
      { initials: "SY", label: "Synthesizer", role: "issues directives", hue: "synthesizer" },
    ],
  },
  {
    cadence: "Quarterly",
    label: "Postmortem Congress",
    one_line: "Retrospective on shipped proposals vs actual lift. Grades the quarter's process health.",
    outputs: "→ graded outcomes seed next quarter's JITR learnings · process notes update prompts",
    personas: [
      { initials: "HI", label: "Head of Insights", role: "grades shipped vs actual", hue: "data" },
      { initials: "CI", label: "Chief Integrity", role: "process-health scorer", hue: "voice" },
      { initials: "AD", label: "Adversary", role: "what did we miss?", hue: "adversary" },
      { initials: "SY", label: "Synthesizer", role: "writes the quarter's memo", hue: "synthesizer" },
    ],
  },
];

const HUE_BG: Record<Persona["hue"], { bg: string; text: string }> = {
  neutral:     { bg: "var(--bg)",                       text: "var(--text-secondary)" },
  data:        { bg: "rgba(59, 130, 246, 0.12)",        text: "var(--blue)"           },
  voice:       { bg: "rgba(139, 92, 246, 0.12)",        text: "#7C3AED"               },
  adversary:   { bg: "rgba(239, 68, 68, 0.12)",         text: "var(--coral)"          },
  synthesizer: { bg: "rgba(245, 158, 11, 0.12)",        text: "var(--gold)"           },
};

export default function CongressAboutPage() {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Four loops, one system.</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4, maxWidth: 720 }}>
            Each loop runs at a different cadence and answers a question the others can&apos;t.
            Lower loops surface decisions; higher loops constrain what the lower ones can propose next cycle.
            Adversary always attacks; Synthesizer always writes the output.
          </p>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {LOOPS.map((loop, i) => (
          <Layer key={loop.cadence} loop={loop} isLast={i === LOOPS.length - 1} />
        ))}
      </div>

      <Legend />
    </div>
  );
}

function Layer({ loop, isLast }: { loop: Loop; isLast: boolean }) {
  return (
    <>
      <section className="section-card" style={{
        padding: "18px 20px",
        display: "grid",
        gridTemplateColumns: "minmax(180px, 220px) 1fr",
        gap: 24,
        alignItems: "start",
      }}>
        {/* Left rail — cadence + label */}
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}>
            {loop.cadence}
          </div>
          <div style={{
            marginTop: 4,
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text)",
            lineHeight: 1.3,
          }}>
            {loop.label}
          </div>
          <div style={{
            marginTop: 10,
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--text-secondary)",
          }}>
            {loop.one_line}
          </div>
          <div style={{
            marginTop: 10,
            fontSize: 11,
            color: "var(--text-tertiary)",
            fontStyle: "italic",
          }}>
            {loop.outputs}
          </div>
        </div>

        {/* Right — persona seats */}
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginBottom: 8,
          }}>
            {loop.personas.length} seats
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {loop.personas.map((p, idx) => <Seat key={idx} p={p} />)}
          </div>
        </div>
      </section>

      {!isLast && <FlowArrow />}
    </>
  );
}

function Seat({ p }: { p: Persona }) {
  const hue = HUE_BG[p.hue];
  return (
    <div
      title={`${p.label} — ${p.role}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: "var(--bg)",
        border: "1px solid var(--border-light)",
        borderRadius: 6,
      }}
    >
      <span style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: "50%",
        fontSize: 10.5,
        fontWeight: 700,
        background: hue.bg,
        color: hue.text,
        flexShrink: 0,
      }}>
        {p.initials}
      </span>
      <span style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.2 }}>
          {p.label}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--text-tertiary)", lineHeight: 1.2 }}>
          {p.role}
        </span>
      </span>
    </div>
  );
}

function FlowArrow() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      fontSize: 11,
      color: "var(--text-tertiary)",
      padding: "4px 0",
    }}>
      <span style={{ flex: 1, height: 0, borderTop: "1px dashed var(--border)", maxWidth: 80 }} />
      <span aria-hidden style={{ fontSize: 14 }}>↓</span>
      <span style={{ flex: 1, height: 0, borderTop: "1px dashed var(--border)", maxWidth: 80 }} />
    </div>
  );
}

function Legend() {
  const items: Array<{ hue: Persona["hue"]; label: string }> = [
    { hue: "data",        label: "Data" },
    { hue: "voice",       label: "Voice / role" },
    { hue: "adversary",   label: "Adversary" },
    { hue: "synthesizer", label: "Synthesizer" },
  ];
  return (
    <div style={{
      marginTop: 24,
      paddingTop: 14,
      borderTop: "1px solid var(--border-light)",
      display: "flex",
      flexWrap: "wrap",
      gap: 18,
      fontSize: 11.5,
      color: "var(--text-tertiary)",
      alignItems: "center",
    }}>
      <span style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>Legend</span>
      {items.map((it, i) => {
        const hue = HUE_BG[it.hue];
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: hue.bg,
              border: `1px solid ${hue.text}33`,
            }} />
            {it.label}
          </span>
        );
      })}
    </div>
  );
}
