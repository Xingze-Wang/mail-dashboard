import { supabase } from "@/lib/db";

const SEND_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONTACT_DEDUP_MS = 365 * 24 * 60 * 60 * 1000;

export const SEND_MIN_AGE_DAYS = 7;
export const CONTACT_DEDUP_DAYS = 365;

export type SendBlock =
  | { ok: true }
  | { ok: false; code: "too_new"; availableAt: string }
  | { ok: false; code: "already_contacted"; lastContactedAt: string }
  | { ok: false; code: "bad_status"; status: string }
  | { ok: false; code: "no_draft" };

interface Lead {
  status: string;
  published_at: string | null;
  draft_subject: string | null;
  draft_html: string | null;
  author_email: string;
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

  const cutoff = new Date(Date.now() - CONTACT_DEDUP_MS).toISOString();
  const { data } = await supabase
    .from("emails")
    .select("created_at")
    .eq("to", lead.author_email.toLowerCase())
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1);

  if (data && data.length > 0) {
    return { ok: false, code: "already_contacted", lastContactedAt: data[0].created_at };
  }

  return { ok: true };
}

export async function wasRecentlyContacted(email: string): Promise<{ contacted: boolean; lastAt: string | null }> {
  const cutoff = new Date(Date.now() - CONTACT_DEDUP_MS).toISOString();
  const { data } = await supabase
    .from("emails")
    .select("created_at")
    .eq("to", email.toLowerCase())
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1);
  if (data && data.length > 0) return { contacted: true, lastAt: data[0].created_at };
  return { contacted: false, lastAt: null };
}
