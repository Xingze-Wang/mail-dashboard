import { supabase } from "@/lib/db";

const SEND_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONTACT_DEDUP_MS = 365 * 24 * 60 * 60 * 1000;

export const SEND_MIN_AGE_DAYS = 7;
export const CONTACT_DEDUP_DAYS = 365;

/**
 * The "firewall" that prevents re-contacting anyone within 365 days.
 * Queries THREE sources in parallel and treats any hit as a block:
 *   1. emails.to              — the authoritative sent log
 *   2. email_contact_history  — legacy dedup table (pre-pipeline_leads)
 *   3. persons.emails[]       — richer contact graph with last_outreach_at
 *
 * All three must be case-normalized because older rows may be mixed-case.
 */
export async function lastContactedAt(emailRaw: string): Promise<string | null> {
  const email = emailRaw.trim().toLowerCase();
  if (!email) return null;
  const cutoff = new Date(Date.now() - CONTACT_DEDUP_MS).toISOString();

  const [emailsHit, historyHit, personsHit] = await Promise.all([
    supabase
      .from("emails")
      .select("created_at, to")
      .ilike("to", email)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("email_contact_history")
      .select("contacted_at")
      .ilike("email", email)
      .gte("contacted_at", cutoff)
      .order("contacted_at", { ascending: false })
      .limit(1),
    supabase
      .from("persons")
      .select("last_outreach_at, emails")
      .contains("emails", [email])
      .gte("last_outreach_at", cutoff)
      .order("last_outreach_at", { ascending: false })
      .limit(1),
  ]);

  const candidates: string[] = [];
  if (emailsHit.data && emailsHit.data.length > 0) candidates.push(emailsHit.data[0].created_at as string);
  if (historyHit.data && historyHit.data.length > 0) candidates.push(historyHit.data[0].contacted_at as string);
  if (personsHit.data && personsHit.data.length > 0) {
    const t = (personsHit.data[0] as { last_outreach_at: string | null }).last_outreach_at;
    if (t) candidates.push(t);
  }
  if (candidates.length === 0) return null;
  // Return the most recent contact across all three.
  return candidates.sort().reverse()[0];
}

export type SendBlock =
  | { ok: true }
  | { ok: false; code: "too_new"; availableAt: string }
  | { ok: false; code: "already_contacted"; lastContactedAt: string }
  | { ok: false; code: "paper_already_contacted"; lastContactedAt: string }
  | { ok: false; code: "bad_status"; status: string }
  | { ok: false; code: "no_draft" };

interface Lead {
  status: string;
  published_at: string | null;
  draft_subject: string | null;
  draft_html: string | null;
  author_email: string;
  arxiv_id?: string | null;
}

export async function checkSendAllowed(lead: Lead): Promise<SendBlock> {
  if (lead.status !== "ready") return { ok: false, code: "bad_status", status: lead.status };
  if (!lead.draft_subject || !lead.draft_html) return { ok: false, code: "no_draft" };

  if (lead.published_at) {
    const published = new Date(lead.published_at).getTime();
    const threshold = Date.now() - SEND_MIN_AGE_MS;
    if (published > threshold) {
      return {
        ok: false,
        code: "too_new",
        availableAt: new Date(published + SEND_MIN_AGE_MS).toISOString(),
      };
    }
  }

  // Person firewall — has this exact recipient been contacted in 365 days?
  const lastAt = await lastContactedAt(lead.author_email);
  if (lastAt) {
    return { ok: false, code: "already_contacted", lastContactedAt: lastAt };
  }

  // Paper firewall — has any co-author of this paper been contacted? Skips
  // for synthesized arxiv ids (HF/PH/GH promotes don't share papers).
  if (lead.arxiv_id && /^\d{4}\.\d{4,5}/.test(lead.arxiv_id)) {
    const paperHit = await paperWasRecentlyContacted(lead.arxiv_id);
    if (paperHit.contacted) {
      return { ok: false, code: "paper_already_contacted", lastContactedAt: paperHit.lastAt! };
    }
  }

  return { ok: true };
}

export async function wasRecentlyContacted(email: string): Promise<{ contacted: boolean; lastAt: string | null }> {
  const lastAt = await lastContactedAt(email);
  return { contacted: lastAt !== null, lastAt };
}

/**
 * Paper-level firewall — has ANY co-author of this paper been contacted in
 * the last 365 days? Stops the "delete the lead row, then a different
 * scraper finds another co-author" loophole.
 *
 * Backed by the paper_arxiv_id column on emails + email_contact_history.
 * Falls through to a pipeline_leads check (sent/replied status) for rows
 * that pre-date the column being filled.
 */
export async function paperWasRecentlyContacted(
  arxivIdCanonical: string,
): Promise<{ contacted: boolean; lastAt: string | null }> {
  const id = arxivIdCanonical.trim().toLowerCase();
  if (!id) return { contacted: false, lastAt: null };
  const cutoff = new Date(Date.now() - CONTACT_DEDUP_MS).toISOString();

  const [emailsHit, historyHit, leadHit] = await Promise.all([
    supabase
      .from("emails")
      .select("created_at")
      .eq("paper_arxiv_id", id)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("email_contact_history")
      .select("contacted_at")
      .eq("paper_arxiv_id", id)
      .gte("contacted_at", cutoff)
      .order("contacted_at", { ascending: false })
      .limit(1),
    supabase
      .from("pipeline_leads")
      .select("sent_at")
      .eq("arxiv_id", id)
      .in("status", ["sent", "replied", "wechat_added"])
      .gte("sent_at", cutoff)
      .order("sent_at", { ascending: false })
      .limit(1),
  ]);

  const candidates: string[] = [];
  if (emailsHit.data?.[0]) candidates.push(emailsHit.data[0].created_at as string);
  if (historyHit.data?.[0]) candidates.push(historyHit.data[0].contacted_at as string);
  if (leadHit.data?.[0]?.sent_at) candidates.push(leadHit.data[0].sent_at as string);
  if (candidates.length === 0) return { contacted: false, lastAt: null };
  return { contacted: true, lastAt: candidates.sort().reverse()[0] };
}
