// Single source of truth for status semantics across the app.
//
// Two status fields exist and they are NOT interchangeable:
//
//   emails.status           — delivery-layer state from Resend.
//                             Monotonic: sent → delivered → opened → clicked,
//                             or sent → bounced/complained. "Latest event wins".
//
//   pipeline_leads.status   — lead lifecycle state owned by this app.
//                             new → queued → drafting → ready → sending → sent
//                             → replied → wechat_added (or skipped).
//
// Using the wrong set in the wrong place is the bug that produced three
// consecutive hotfix commits (32e3f6e, e412ae0, b0f525c). Every call site
// now imports from here.

// ── emails.status (delivery layer) ──────────────────────────────────────

export const EMAIL_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Statuses that mean "Resend confirmed this email reached the recipient's
 * mailbox (or further)". `complained` is included because a spam complaint
 * proves delivery happened.
 *
 * Use for top-of-funnel delivery-rate math (num delivered / num sent).
 */
export const DELIVERED_STATUSES = ["delivered", "clicked", "complained"] as const;

/**
 * Statuses used as the "we actually emailed this recipient" set on the
 * emails table. Differs from DELIVERED_STATUSES because it INCLUDES
 * `sent` (Resend accepted but webhook hasn't confirmed delivery yet) and
 * `replied` (a reply implies the send worked), and EXCLUDES `complained`
 * (a spam complaint should not inflate the denominator of conversion
 * rates — the person is angry, not a lead).
 *
 * Use for per-rep recipient sets, conversion-rate denominators, and
 * "distinct people this rep has emailed" sets.
 */
export const REACHABLE_EMAIL_STATUSES = ["delivered", "clicked", "sent", "replied"] as const;

/**
 * Maps any form of Resend event indicator → canonical EmailStatus.
 *
 * Resend uses two shapes for the same set of events:
 *   - Webhooks send `type: "email.delivered"` (prefixed).
 *   - The list/get API returns `last_event: "delivered"` (unprefixed).
 *
 * This table handles both. `delivery_delayed` collapses to `sent` because
 * the email has been accepted by Resend but not yet delivered — the
 * lead-level view treats it identically to `sent`.
 */
export const RESEND_EVENT_TO_STATUS: Record<string, EmailStatus> = {
  // Prefixed (webhooks)
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "sent",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  // Unprefixed (list/get API)
  sent: "sent",
  delivered: "delivered",
  delivery_delayed: "sent",
  opened: "opened",
  clicked: "clicked",
  bounced: "bounced",
  complained: "complained",
};

export function mapResendEventToStatus(eventOrLastEvent: string | null | undefined): EmailStatus {
  if (!eventOrLastEvent) return "sent";
  return RESEND_EVENT_TO_STATUS[eventOrLastEvent] ?? "sent";
}

// ── pipeline_leads.status (lead layer) ──────────────────────────────────

export const LEAD_STATUSES = [
  "new",
  "queued",
  "drafting",
  "ready",
  "sending",
  "sent",
  "replied",
  "wechat_added",
  "skipped",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * "An outbound email went out and the lead has been contacted."
 *
 * Includes `replied` because a reply is a LATER phase of the same send,
 * not a displacement of it — the outbound email still happened. Includes
 * `wechat_added` because once a researcher is on WeChat, the contact is
 * real even if the email never advanced past "sent" in our UI.
 *
 * Use this anywhere you mean "this lead has been reached":
 *   - per-rep sent counts
 *   - contact-guard dedup filter
 *   - scorer's training-set "was-sent" label
 *   - analytics "sent" column
 *
 * Do NOT hand-roll `status in ('sent','replied',...)` arrays — import
 * this constant.
 */
export const CONTACTED_LEAD_STATUSES = ["sent", "replied", "wechat_added"] as const;

/**
 * Terminal-ish lead states — the lead will not progress further without
 * external action. `skipped` is terminal. `wechat_added` is terminal-good.
 */
export const TERMINAL_LEAD_STATUSES = ["wechat_added", "skipped"] as const;

export function isContactedLeadStatus(status: string | null | undefined): status is (typeof CONTACTED_LEAD_STATUSES)[number] {
  return status !== null && status !== undefined && (CONTACTED_LEAD_STATUSES as readonly string[]).includes(status);
}

export function isDeliveredEmailStatus(status: string | null | undefined): status is (typeof DELIVERED_STATUSES)[number] {
  return status !== null && status !== undefined && (DELIVERED_STATUSES as readonly string[]).includes(status);
}
