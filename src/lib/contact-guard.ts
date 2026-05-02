import { supabase } from "@/lib/db";
import { CONTACTED_LEAD_STATUSES } from "@/lib/status";

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

  // If ANY of the three queries errored, we don't know for sure whether
  // this recipient was recently contacted. Fail-CLOSED with a synthetic
  // "now" timestamp so the send is blocked until the DB recovers. Fail-
  // open (the prior behavior) could double-contact recipients when a
  // transient DB error hid a prior send.
  if (emailsHit.error || historyHit.error || personsHit.error) {
    console.error("lastContactedAt partial failure; failing CLOSED", {
      emailsErr: emailsHit.error?.message,
      historyErr: historyHit.error?.message,
      personsErr: personsHit.error?.message,
    });
    return new Date().toISOString();
  }

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
  | { ok: false; code: "repo_already_contacted"; lastContactedAt: string; repo: string }
  | { ok: false; code: "do_not_contact"; reason: string }
  | { ok: false; code: "bad_status"; status: string }
  | { ok: false; code: "no_draft" };

/**
 * Repo-level firewall — has any paper sharing this HF or GitHub repo been
 * contacted in the last 365 days? Catches the "lab posts v2 of the same
 * project under a new arxiv id and a new lead surfaces" case.
 *
 * Looks up `papers.last_outreach_at` for any paper with the same hf_repo or
 * github_repo. Returns the most recent contact across all such papers.
 */
export async function repoWasRecentlyContacted(
  repo: { hf_repo?: string | null; github_repo?: string | null },
): Promise<{ contacted: boolean; lastAt: string | null; matchedRepo: string | null }> {
  const cutoff = new Date(Date.now() - CONTACT_DEDUP_MS).toISOString();
  // Wrap the supabase builders in `Promise.resolve` so TS sees them as
  // Promise<...>. The supabase-js builder is thenable but its TS type
  // doesn't flatten to Promise without an explicit Promise wrapper in
  // a typed array.
  type RepoLookup = { data: { last_outreach_at: string | null }[] | null; error: unknown };
  const queries: Promise<RepoLookup>[] = [];
  if (repo.hf_repo) {
    queries.push(
      Promise.resolve(
        supabase
          .from("papers")
          .select("last_outreach_at")
          .eq("hf_repo", repo.hf_repo)
          .gte("last_outreach_at", cutoff)
          .order("last_outreach_at", { ascending: false })
          .limit(1),
      ) as unknown as Promise<RepoLookup>,
    );
  }
  if (repo.github_repo) {
    queries.push(
      Promise.resolve(
        supabase
          .from("papers")
          .select("last_outreach_at")
          .eq("github_repo", repo.github_repo)
          .gte("last_outreach_at", cutoff)
          .order("last_outreach_at", { ascending: false })
          .limit(1),
      ) as unknown as Promise<RepoLookup>,
    );
  }
  if (queries.length === 0) return { contacted: false, lastAt: null, matchedRepo: null };

  const results = await Promise.all(queries);
  const candidates: { at: string; repo: string }[] = [];
  if (repo.hf_repo && results[0]?.data?.[0]?.last_outreach_at) {
    candidates.push({ at: results[0].data[0].last_outreach_at as string, repo: `hf:${repo.hf_repo}` });
  }
  const ghIdx = repo.hf_repo ? 1 : 0;
  if (repo.github_repo && results[ghIdx]?.data?.[0]?.last_outreach_at) {
    candidates.push({ at: results[ghIdx].data[0].last_outreach_at as string, repo: `gh:${repo.github_repo}` });
  }
  if (candidates.length === 0) return { contacted: false, lastAt: null, matchedRepo: null };
  candidates.sort((a, b) => b.at.localeCompare(a.at));
  return { contacted: true, lastAt: candidates[0].at, matchedRepo: candidates[0].repo };
}

/**
 * Hard block: any person whose `outreach_status='do_not_contact'` is owned by
 * one of the recipient emails. Distinct from `already_contacted` (which only
 * fires when there is a recent send) — DNC blocks even on first contact.
 */
export async function isDoNotContact(emailRaw: string): Promise<{ blocked: boolean; reason: string | null }> {
  const email = emailRaw.trim().toLowerCase();
  if (!email) return { blocked: false, reason: null };

  const { data, error } = await supabase
    .from("persons")
    .select("id, real_name, outreach_status")
    .contains("emails", [email])
    .eq("outreach_status", "do_not_contact")
    .limit(1);

  if (error) {
    // Fail CLOSED — same logic as lastContactedAt
    console.error("isDoNotContact failed; failing CLOSED", error.message);
    return { blocked: true, reason: "DNC check failed (db error)" };
  }
  if (data && data.length > 0) {
    const p = data[0] as { id: string; real_name: string | null };
    return { blocked: true, reason: `do_not_contact person ${p.real_name ?? p.id}` };
  }
  return { blocked: false, reason: null };
}

interface Lead {
  status: string;
  published_at: string | null;
  draft_subject: string | null;
  draft_html: string | null;
  author_email: string;
  arxiv_id?: string | null;
  hf_repo?: string | null;
  github_repo?: string | null;
}

export async function checkSendAllowed(lead: Lead, opts: { override?: boolean } = {}): Promise<SendBlock> {
  if (lead.status !== "ready") return { ok: false, code: "bad_status", status: lead.status };
  if (!lead.draft_subject || !lead.draft_html) return { ok: false, code: "no_draft" };

  // Paper-age check anchored on published_at — a separate, older guardrail
  // from the pipeline-age gate in policy.ts. The pipeline-age gate already
  // ran upstream of this call; when the caller signals `override: true`,
  // we respect that decision here too (previously this path silently
  // rejected with code:"too_new" even when the user had ticked the
  // override toggle — the warning looked identical to the overridable
  // age-gate message, so sales couldn't tell the two rules apart).
  if (lead.published_at && !opts.override) {
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

  // DNC firewall — never contact persons flagged do_not_contact, even on
  // first attempt. Runs before the recency check because DNC is a harder
  // signal (manual flag, often a known-bad relationship).
  const dnc = await isDoNotContact(lead.author_email);
  if (dnc.blocked) {
    return { ok: false, code: "do_not_contact", reason: dnc.reason ?? "do_not_contact" };
  }

  // Person firewall — has this exact recipient been contacted in 365 days?
  const lastAt = await lastContactedAt(lead.author_email);
  if (lastAt) {
    return { ok: false, code: "already_contacted", lastContactedAt: lastAt };
  }

  // Paper firewall — has any co-author of this paper been contacted? Skips
  // for synthesized arxiv ids (HF/PH/GH promotes don't share papers).
  // Match canonical arxiv ids: YYMM.NNNNN with optional vN suffix.
  // Previously unanchored, so "2401.12345-v2" and similar slipped through.
  if (lead.arxiv_id && /^\d{4}\.\d{4,5}(v\d+)?$/.test(lead.arxiv_id)) {
    const paperHit = await paperWasRecentlyContacted(lead.arxiv_id);
    if (paperHit.contacted) {
      return { ok: false, code: "paper_already_contacted", lastContactedAt: paperHit.lastAt! };
    }
  }

  // Repo firewall — same HF or GitHub repo already contacted? Catches "lab
  // re-posts under a new arxiv id" — they share the project repo.
  if (lead.hf_repo || lead.github_repo) {
    const repoHit = await repoWasRecentlyContacted({ hf_repo: lead.hf_repo, github_repo: lead.github_repo });
    if (repoHit.contacted) {
      return {
        ok: false,
        code: "repo_already_contacted",
        lastContactedAt: repoHit.lastAt!,
        repo: repoHit.matchedRepo!,
      };
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
      .in("status", [...CONTACTED_LEAD_STATUSES])
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
