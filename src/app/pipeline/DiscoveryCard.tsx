"use client";

/**
 * Person-shaped discovery card for the design-D pipeline stream.
 *
 * Renders a row from `discovery_leads` (HF / GitHub / Product Hunt) using
 * the same dx-card geometry as the paper-shaped LeadRow, but with handle
 * + signal chips + bio + contact hints instead of paper title + draft.
 *
 * Action handlers are mostly stubs — the discovery → pipeline_leads
 * promotion path lives in the Python scrapers + a dedicated POST endpoint
 * that doesn't exist yet. We surface the buttons so the layout matches
 * the mockup; clicks toast "Coming soon". `View profile` opens the row's
 * profileUrl in a new tab.
 */

import { memo, useMemo } from "react";
import {
  Globe, CheckCircle2, MapPin, ExternalLink, Search,
} from "lucide-react";
import { DiscoveryLead } from "./types";
import { SOURCE_LABELS, type SourceCode } from "@/lib/sources";

/* Inline brand-icon SVGs — lucide-react in this project doesn't ship the
   Twitter / X mark, so we inline the same path used in redesign-D.html. */
const TwitterIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <path d="M18 2h3l-7 8 8 12h-6l-5-7-6 7H2l8-9L2 2h6l4 6z" />
  </svg>
);

interface Props {
  lead: DiscoveryLead;
  onAction: (action: "find" | "promote" | "mute" | "view", lead: DiscoveryLead) => void;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "future";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}

function srcBadgeClass(source: string): "arxiv" | "hf" | "gh" | "ph" {
  const s = source.toLowerCase();
  if (s === "hf" || s === "huggingface") return "hf";
  if (s === "github" || s === "gh") return "gh";
  if (s === "ph" || s === "producthunt") return "ph";
  return "arxiv";
}

function sourceLabel(source: string): string {
  const s = source.toLowerCase() as SourceCode;
  return SOURCE_LABELS[s] ?? source;
}

/**
 * Pick up to 5 humanized signal chips from the `signals` jsonb. We
 * surface a few well-known signals first (CN markers, org affiliation,
 * verified status, model count, etc), then fall back to remaining keys.
 */
function buildSignalChips(lead: DiscoveryLead): Array<{ label: string; variant?: "score" | "cn" | "org" | "default" }> {
  const chips: Array<{ label: string; variant?: "score" | "cn" | "org" | "default" }> = [];
  const signals = lead.signals || {};

  // Score is always first if > 0.
  if (lead.score > 0) {
    chips.push({ label: `score ${lead.score.toFixed(2)}`, variant: "score" });
  }

  // CN markers (rose tint).
  const cnSignal =
    signals.cn_org ||
    signals.cn_founder ||
    signals.cn_based ||
    signals.zh_readme ||
    signals.chinese_bio;
  if (cnSignal) {
    const label =
      typeof cnSignal === "string"
        ? cnSignal
        : signals.cn_org
          ? "CN org"
          : signals.cn_founder
            ? "CN founder"
            : signals.zh_readme
              ? "中文 README"
              : signals.chinese_bio
                ? "中文 bio"
                : "CN-based";
    chips.push({ label, variant: "cn" });
  }

  // Org/affiliation (blue tint).
  if (lead.org) {
    chips.push({ label: lead.org, variant: "org" });
  } else if (signals.affiliation && typeof signals.affiliation === "string") {
    chips.push({ label: signals.affiliation, variant: "org" });
  }

  // Location.
  if (lead.location) {
    chips.push({ label: lead.location, variant: "default" });
  }

  // Remaining well-known boolean / count signals.
  const remainingKnown = [
    ["verified", "verified"],
    ["trending", "trending"],
    ["recent_push", "recent push"],
    ["first_launch", "first launch"],
    ["model_count", "models"],
    ["star_count", "stars"],
  ] as const;
  for (const [key, label] of remainingKnown) {
    if (chips.length >= 5) break;
    const v = signals[key];
    if (v === true) chips.push({ label, variant: "default" });
    else if (typeof v === "number" && v > 0) chips.push({ label: `${v} ${label}`, variant: "default" });
  }

  // Fill from any other string signal values we haven't surfaced.
  for (const [key, value] of Object.entries(signals)) {
    if (chips.length >= 5) break;
    if (typeof value === "string" && value.length > 0 && value.length < 28) {
      const already = chips.some((c) => c.label === value);
      if (!already && !["affiliation"].includes(key)) {
        chips.push({ label: value, variant: "default" });
      }
    }
  }

  return chips.slice(0, 5);
}

function buildHeadMeta(lead: DiscoveryLead): string[] {
  const out: string[] = [];
  const s = lead.signals || {};
  if (typeof s.model_count === "number") out.push(`${s.model_count} models`);
  if (typeof s.star_count === "number") out.push(`${s.star_count.toLocaleString()} stars`);
  if (typeof s.followers === "number") out.push(`${s.followers.toLocaleString()} followers`);
  if (typeof s.upvotes === "number") out.push(`${s.upvotes} upvotes`);
  if (typeof s.contributors === "number") out.push(`${s.contributors} contribs`);
  if (typeof s.rank === "number") out.push(`#${s.rank} of the day`);
  out.push(relativeTime(lead.lastSeen) || relativeTime(lead.firstSeen));
  return out.filter(Boolean);
}

function pickContactHints(lead: DiscoveryLead): Array<{ icon: "twitter" | "globe" | "email"; href?: string; key?: string; value: string; muted?: boolean }> {
  const hints: Array<{ icon: "twitter" | "globe" | "email"; href?: string; key?: string; value: string; muted?: boolean }> = [];
  const s = lead.signals || {};

  const twitter =
    (typeof s.twitter === "string" ? s.twitter : null) ??
    (typeof s.twitter_handle === "string" ? s.twitter_handle : null);
  if (twitter) {
    const handle = twitter.startsWith("@") ? twitter : `@${twitter.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//, "")}`;
    const href = twitter.startsWith("http") ? twitter : `https://twitter.com/${handle.replace(/^@/, "")}`;
    hints.push({ icon: "twitter", href, value: handle });
  }

  const website =
    (typeof s.website === "string" ? s.website : null) ??
    (typeof s.homepage === "string" ? s.homepage : null) ??
    (typeof s.blog === "string" ? s.blog : null);
  if (website) {
    const display = website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    hints.push({ icon: "globe", href: website.startsWith("http") ? website : `https://${website}`, value: display });
  }

  if (lead.email) {
    hints.push({ icon: "email", key: "Email:", value: lead.email });
  } else if (lead.contactHint) {
    hints.push({ icon: "email", key: "Email guess:", value: lead.contactHint });
  } else {
    hints.push({ icon: "email", key: "Email guess:", value: "none yet", muted: true });
  }

  return hints;
}

function DiscoveryCardInner({ lead, onAction }: Props) {
  const variant = srcBadgeClass(lead.source);
  const label = sourceLabel(lead.source);
  const chips = useMemo(() => buildSignalChips(lead), [lead]);
  const headMeta = useMemo(() => buildHeadMeta(lead), [lead]);
  const hints = useMemo(() => pickContactHints(lead), [lead]);

  const handle = useMemo(() => {
    const ext = lead.externalId;
    // GitHub repos look like "owner/repo"; HF/PH are usually plain handles.
    if (variant === "gh" && ext.includes("/")) return ext;
    return ext.startsWith("@") ? ext : `@${ext}`;
  }, [variant, lead.externalId]);

  return (
    <div className="dx-card discovered">
      <div className="dx-card-head">
        <span className={`dx-src-badge ${variant}`}>
          <span className="dx-src-dot" />
          {label}
        </span>
        <span className="dx-status-badge discovered">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6" /></svg>
          Discovered
        </span>
        {headMeta.length > 0 && (
          <span className="dx-head-meta">
            {headMeta.map((m, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {i > 0 && <span className="dx-meta-dot" />}
                <span>{m}</span>
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="dx-card-title handle">
        <span className="dx-handle-mono">{handle}</span>
        {lead.fullname && <span className="dx-fullname">{lead.fullname}</span>}
      </div>

      {chips.length > 0 && (
        <div className="dx-signal-chips">
          {chips.map((c, i) => (
            <span key={i} className={`dx-sig-chip${c.variant && c.variant !== "default" ? ` ${c.variant}` : ""}`}>
              {c.variant === "cn" && (
                <MapPin />
              )}
              {c.label}
            </span>
          ))}
        </div>
      )}

      {lead.bio && <div className="dx-bio">{lead.bio}</div>}

      {hints.length > 0 && (
        <div className="dx-contact-hints">
          {hints.map((h, i) => {
            const inner = (
              <>
                {h.icon === "twitter" && <TwitterIcon />}
                {h.icon === "globe" && <Globe />}
                {h.icon === "email" && <CheckCircle2 style={{ opacity: h.muted ? 0.4 : 0.6 }} />}
                {h.key && <span className="dx-h-key">{h.key}</span>}
                <span className="dx-h-val" style={h.muted ? { color: "var(--dx-text-3)" } : undefined}>
                  {h.value}
                </span>
              </>
            );
            if (h.href) {
              return (
                <a key={i} className="dx-contact-hint" href={h.href} target="_blank" rel="noopener noreferrer">
                  {inner}
                </a>
              );
            }
            return (
              <span key={i} className="dx-contact-hint">
                {inner}
              </span>
            );
          })}
        </div>
      )}

      <div className="dx-card-foot">
        <span className="dx-foot-meta">
          {lead.promotedAt
            ? `Promoted ${relativeTime(lead.promotedAt)}`
            : lead.email
              ? "Found email · ready to promote"
              : "Unassigned · awaiting enrichment"}
        </span>
        <div className="dx-foot-actions">
          <button type="button" className="dx-ghost" onClick={() => onAction("mute", lead)}>
            Mute
          </button>
          {lead.profileUrl && (
            <a
              href={lead.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="dx-secondary"
            >
              <ExternalLink />
              View profile
            </a>
          )}
          {lead.email ? (
            <button type="button" className="dx-primary" onClick={() => onAction("promote", lead)}>
              Promote to lead
            </button>
          ) : (
            <button type="button" className="dx-primary find" onClick={() => onAction("find", lead)}>
              <Search />
              Find email
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const DiscoveryCard = memo(DiscoveryCardInner);
