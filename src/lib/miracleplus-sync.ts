// MiraclePlus contact sync — pulls contacts from MP's CRM by email and
// upserts into `miracleplus_contacts`. Read by getMpConversionMatrix.
//
// Two entry points:
//   syncContactByEmail(email)        — one email, one round-trip.
//   syncRecentOutbound({since})      — pulls every distinct recipient
//                                      from the `emails` table we
//                                      reached in the lookback window
//                                      and runs syncContactByEmail on
//                                      each with a 200ms gap.
//
// Why the gap: parent team hasn't published a rate limit. 200ms = 5
// rps is well below "polite ceiling" for most public APIs; we can
// tune up once we have data.

import { supabase } from "@/lib/db";
import {
  mpSearchContactsByEmail,
  type MpContact,
} from "@/lib/miracleplus-api";
import { REACHABLE_EMAIL_STATUSES } from "@/lib/status";

const RATE_LIMIT_MS = 200;

function canonicalEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  // Masked emails (e.g. "******") have no usable canonical form.
  // Returning NULL here means the row still gets stored, but it won't
  // join against pipeline_leads / emails — which is correct.
  if (trimmed.replace(/\*/g, "").length === 0) return null;
  return trimmed;
}

/**
 * Sync one email's worth of contacts from MP into our mirror table.
 * Idempotent — re-running on the same email upserts on mp_id and bumps
 * last_seen_at.
 *
 * Returns `{ matched, contacts }` where matched is the count from MP's
 * response and contacts is the raw API rows so callers can do more
 * with them (e.g. the smoke script prints one).
 */
export async function syncContactByEmail(email: string): Promise<{
  matched: number;
  contacts: MpContact[];
  error?: string;
}> {
  const clean = canonicalEmail(email);
  if (!clean) return { matched: 0, contacts: [], error: "email not searchable" };

  const contacts = await mpSearchContactsByEmail(clean);
  if (contacts.length === 0) return { matched: 0, contacts: [] };

  // Build the upsert payload. We canonicalize the MP-returned email
  // (not our search input) so a contact that happens to be unmasked
  // in MP joins on its real value rather than ours.
  const rows = contacts.map((c) => ({
    mp_id: c.id,
    email: typeof c.email === "string" ? c.email : null,
    email_canonical: canonicalEmail(typeof c.email === "string" ? c.email : null) ?? clean,
    name: c.name ?? null,
    phone: c.phone ?? null,
    application_progress: c.application_progress ?? null,
    application_stage: c.application_stage ?? null,
    applications_number:
      typeof c.applications_number === "number" ? c.applications_number : null,
    submitted_at: c.submitted_at ?? null,
    created_application_at: c.created_application_at ?? null,
    project: c.project ?? null,
    s_product: c.s_product ?? null,
    s_channel: c.s_channel ?? null,
    utm_source: c.utm_source ?? null,
    raw: c as unknown as Record<string, unknown>,
    last_seen_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("miracleplus_contacts")
    .upsert(rows, { onConflict: "mp_id" });

  if (error) {
    return { matched: contacts.length, contacts, error: error.message };
  }
  return { matched: contacts.length, contacts };
}

/**
 * Pull every distinct recipient our reps actually emailed since
 * `since`, then sync each one against MP. This is the daily-cron
 * primitive — we don't try to be clever about "only contacts we
 * haven't synced yet" because (a) the 7-day overlap is small (b)
 * upserts are idempotent (c) MP contact state changes over time and
 * re-syncing is how we catch "they finally submitted yesterday".
 *
 * Filter rationale:
 *   - emails.created_at > since  → fresh outreach only.
 *   - status IN REACHABLE_EMAIL_STATUSES → exclude bounced / queued.
 *     We don't bother syncing contacts our email didn't reach.
 */
export async function syncRecentOutbound({ since }: { since: Date }): Promise<{
  checked: number;
  found: number;
  errors: number;
  ms: number;
}> {
  const t0 = Date.now();
  const sinceIso = since.toISOString();

  // Pull recipients. PostgREST default limit is 1000 — paginate to be
  // safe. We don't need any fields besides `to`.
  const all: Array<{ to: string | null }> = [];
  const PAGE = 1000;
  let cursor = 0;
  const MAX_ROWS = 50_000;
  while (cursor < MAX_ROWS) {
    const { data, error } = await supabase
      .from("emails")
      .select("to")
      .gte("created_at", sinceIso)
      .in("status", REACHABLE_EMAIL_STATUSES as readonly string[])
      .range(cursor, cursor + PAGE - 1);
    if (error) {
      // If the very first page errors, return what we have so far
      // rather than crashing the cron.
      console.warn("[mp-sync] emails fetch error", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }

  const uniq = new Set<string>();
  for (const r of all) {
    const c = canonicalEmail(r.to);
    if (c) uniq.add(c);
  }

  let checked = 0;
  let found = 0;
  let errors = 0;
  for (const email of uniq) {
    try {
      const r = await syncContactByEmail(email);
      checked++;
      if (r.matched > 0) found++;
      if (r.error) errors++;
    } catch (err) {
      errors++;
      console.warn("[mp-sync] syncContactByEmail threw", { email, err: String(err).slice(0, 200) });
    }
    // Polite rate limit. Skip the sleep on the last iteration so we
    // don't waste 200ms returning.
    if (checked < uniq.size) {
      await new Promise((res) => setTimeout(res, RATE_LIMIT_MS));
    }
  }

  return { checked, found, errors, ms: Date.now() - t0 };
}
