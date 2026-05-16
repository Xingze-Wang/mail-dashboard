// 3 golden-standard signal pills: 注册 (registered) / 开表 (submitted application) / 微信 (added wechat).
//
// This is the SINGLE component for surfacing MP+WeChat conversion state
// anywhere in the app. Used by /pipeline LeadRow, /brief detail, /emails
// inbox, /admin/missions RepCard, /analysis segment rows, Leon prose,
// etc. Centralizing here means colors + Chinese labels + fill semantics
// never drift between surfaces.
//
// Two sizes:
//   sm  — 3 colored dots, 6px each, no labels. For row-level density.
//   md  — pill with 1-char label "注 开 微". For card / detail surfaces.
//
// Three fill states per pill:
//   solid — signal present.
//   ghost — signal absent (greyed outline). Renders for ALL rows so the
//           absence is visible — "we sent and they did NOT register" is
//           itself a signal.
//   na    — null (e.g. no email to join on). Hidden / dim "-".
//
// Server-side source of truth: src/lib/canonical-counts.ts
//   - getMpSignalsForEmails(emails[]) for bulk per-lead lookups (LeadRow)
//   - getMpConversionMatrix({ actorRepId, since }) for aggregate tiles
//   - bucketMpProgress(row) for ad-hoc classification

export interface MpSignals {
  registered: boolean;
  submittedApplication: boolean;
  addedWechat: boolean;
}

type Size = "sm" | "md";

const COLORS = {
  // Registered: cyan/blue — "they're known to MP, not yet converted".
  registered: { on: "#3b82f6", off: "#cbd5e1" },
  // Submitted: emerald — THE conversion. Most prominent.
  submittedApplication: { on: "#10b981", off: "#cbd5e1" },
  // WeChat: rose/pink — the warm-touch signal.
  addedWechat: { on: "#ec4899", off: "#cbd5e1" },
} as const;

const LABEL_ZH = {
  registered: "注",
  submittedApplication: "开",
  addedWechat: "微",
} as const;

const LABEL_FULL_ZH = {
  registered: "注册",
  submittedApplication: "开表",
  addedWechat: "微信",
} as const;

interface Props {
  signals: MpSignals | null;
  size?: Size;
  /** Show 1-char Chinese label inside each pill (md only). */
  showLabels?: boolean;
  /** Compress visually when no signal at all (saves row real estate). */
  hideIfEmpty?: boolean;
  /** Optional tooltip detail (e.g. application_progress). */
  applicationProgress?: string | null;
}

export function MpSignalPills({
  signals,
  size = "sm",
  showLabels,
  hideIfEmpty = false,
  applicationProgress,
}: Props) {
  if (!signals && hideIfEmpty) return null;
  const s: MpSignals = signals ?? {
    registered: false,
    submittedApplication: false,
    addedWechat: false,
  };
  const total = (s.registered ? 1 : 0) + (s.submittedApplication ? 1 : 0) + (s.addedWechat ? 1 : 0);
  if (hideIfEmpty && total === 0) return null;

  const dim = size === "sm" ? 8 : 18;
  const gap = size === "sm" ? 3 : 4;
  const useLabels = showLabels ?? size === "md";

  const tooltip = (key: keyof MpSignals, on: boolean) => {
    const verb = on ? "已" : "未";
    const base = `${verb}${LABEL_FULL_ZH[key]}`;
    if (key === "submittedApplication" && on && applicationProgress) {
      return `${base} · ${applicationProgress}`;
    }
    return base;
  };

  const renderOne = (key: keyof MpSignals) => {
    const on = s[key];
    const color = COLORS[key];
    return (
      <span
        key={key}
        title={tooltip(key, on)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: dim,
          height: dim,
          borderRadius: size === "sm" ? "50%" : 4,
          background: on ? color.on : "transparent",
          border: on ? "none" : `1px dashed ${color.off}`,
          color: on ? "#fff" : color.off,
          fontSize: size === "sm" ? 0 : 11,
          fontWeight: 600,
          lineHeight: 1,
          fontFamily: "var(--font-heading), system-ui",
        }}
      >
        {useLabels ? LABEL_ZH[key] : null}
      </span>
    );
  };

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap, verticalAlign: "middle" }}
    >
      {renderOne("registered")}
      {renderOne("submittedApplication")}
      {renderOne("addedWechat")}
    </span>
  );
}

/**
 * Aggregate-numbers variant of the pills. For tiles/cards that show
 * "N registered · M submitted · K wechat" totals from
 * getMpConversionMatrix() (not per-lead). Same color scheme; rendered
 * as a stat trio.
 */
export function MpSignalCounts({
  registered,
  submittedApplication,
  addedWechat,
  totalEmailed,
  size = "md",
}: {
  registered: number;
  submittedApplication: number;
  addedWechat: number;
  totalEmailed?: number;
  size?: Size;
}) {
  const cell = (key: keyof MpSignals, value: number) => {
    const color = COLORS[key];
    const labelFull = LABEL_FULL_ZH[key];
    const pct =
      typeof totalEmailed === "number" && totalEmailed > 0
        ? ` (${((value / totalEmailed) * 100).toFixed(0)}%)`
        : "";
    return (
      <span
        key={key}
        title={
          typeof totalEmailed === "number"
            ? `${labelFull}: ${value} / ${totalEmailed} sent${pct}`
            : `${labelFull}: ${value}`
        }
        style={{
          display: "inline-flex",
          alignItems: "baseline",
          gap: 4,
          fontSize: size === "sm" ? 11 : 13,
          fontWeight: 600,
          color: value > 0 ? color.on : "var(--text-tertiary, #94a3b8)",
          fontFamily: "var(--font-heading), system-ui",
        }}
      >
        <span>{value}</span>
        <span style={{ fontSize: size === "sm" ? 9 : 10, fontWeight: 500, opacity: 0.8 }}>
          {labelFull}
        </span>
      </span>
    );
  };
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline" }}>
      {cell("registered", registered)}
      <span style={{ color: "var(--border, #e2e8f0)" }}>·</span>
      {cell("submittedApplication", submittedApplication)}
      <span style={{ color: "var(--border, #e2e8f0)" }}>·</span>
      {cell("addedWechat", addedWechat)}
    </span>
  );
}
