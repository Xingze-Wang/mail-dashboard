// Single source of truth for "which rep does this inbound belong to."
//
// We had three writers (api/webhook/email.received, api/inbound, lib/sync
// inbound phase) that each forgot to stamp rep_id, leaving 17 of 22
// inbound rows with rep_id=NULL — invisible to per-rep inbox scoping
// and per-rep reply metrics.
//
// The most reliable signal is the recipient address: inbound.to matches
// exactly one sales_reps.sender_email. Falls back to thread_id lookup
// (find the originating outbound's rep_id) if the recipient address
// can't be resolved (e.g., team alias).

import { supabase } from "@/lib/db";

let cachedReps: Array<{ id: number; sender_email: string | null }> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/** Cached so we don't refetch on every webhook. Sales rep list changes
 *  rarely — once a minute is plenty fresh.
 *
 *  No active=true filter: a reply to an inactive rep still belongs to
 *  that rep's inbox. Filtering here was the cause of inbound rows
 *  landing with rep_id=NULL and disappearing from the inbox. */
async function loadReps(): Promise<Array<{ id: number; sender_email: string | null }>> {
  const now = Date.now();
  if (cachedReps && now - cachedAt < CACHE_TTL_MS) return cachedReps;
  const { data } = await supabase.from("sales_reps").select("id, sender_email");
  cachedReps = data ?? [];
  cachedAt = now;
  return cachedReps;
}

/** Pull the bare email out of "Name <addr@x>" or "addr@x" or '["addr@x"]'. */
function extractEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // Defend against JSON-stringified arrays from older imports.
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed) && parsed.length > 0) s = String(parsed[0]).trim();
    } catch {
      // not valid JSON, fall through and treat as comma-string
    }
  }
  // Multi-recipient: take the first.
  s = s.split(",")[0].trim();
  // "Name <addr>" → addr
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).toLowerCase().trim();
  return addr.includes("@") ? addr : null;
}

/**
 * Resolve which rep an inbound email belongs to.
 *
 * Resolution order:
 *   1. inbound.to matches sales_reps.sender_email exactly → that rep
 *   2. inbound.to matches sales_reps.sender_email substring → that rep
 *      (handles "Leo <leo@compute.miracleplus.com>" and similar)
 *   3. thread_id lookup → originating outbound's rep_id
 *   4. null (genuinely unknown — e.g. team alias, forwarded mail)
 *
 * @param to inbound `to` field (raw, may contain display name / array form)
 * @param threadId optional thread_id for fallback lookup
 */
export async function resolveInboundRepId(
  to: string | null | undefined,
  threadId: string | null | undefined,
): Promise<number | null> {
  const recipient = extractEmail(to);
  if (recipient) {
    const reps = await loadReps();
    // Exact match only. We previously did a substring fallback
    // (`recipient.includes(rep.sender_email)`) which mis-attributed
    // when one rep's email was a substring of another's: a reply to
    // "newsales@x.com" would match "sales@x.com" first because the
    // loop iterated by id and the `includes` test returned true.
    // The thread_id fallback below covers display-name wrappers
    // (extractEmail already strips "Name <addr>"), so we don't lose
    // any real attribution by tightening this.
    for (const r of reps) {
      if (r.sender_email && r.sender_email.toLowerCase() === recipient) return r.id;
    }
  }

  // Fallback: who sent the original outbound on this thread?
  if (threadId) {
    const { data } = await supabase
      .from("emails")
      .select("rep_id")
      .eq("thread_id", threadId)
      .not("rep_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data?.rep_id) return data.rep_id as number;
  }

  return null;
}
