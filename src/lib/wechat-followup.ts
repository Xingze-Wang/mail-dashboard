// WeChat follow-up nudge — when a rep marked someone "Added on WeChat"
// 3+ days ago and there's been no inbound reply on that thread since,
// it's worth a chime-back. The helper bot surfaces this on session
// open so the rep doesn't lose the warm hand.
//
// Definition: a "stale" wechat conversion is one where:
//   - brief_lookups.added_wechat = true AND marked_by_rep_id IS NOT NULL
//   - wechat_at (or created_at fallback) was ≥ FOLLOWUP_DAYS days ago
//   - no inbound_emails for that lead's recipient since the wechat mark
//
// We don't try to be clever about "did the rep already nudge" — that
// detection would need to look for outbound to the same recipient
// after wechat_at, and the rep can dismiss the nudge if they already
// followed up. Better to over-nudge than to lose a warm lead silently.

import { supabase } from "@/lib/db";

const FOLLOWUP_DAYS = 3;

export interface StaleWechat {
  lead_id: string;
  rep_id: number;
  marked_at: string;
  recipient: string | null;
  lead_title: string | null;
  days_stale: number;
}

export async function getStaleWechatFollowups(repId: number | null = null): Promise<StaleWechat[]> {
  const cutoff = new Date(Date.now() - FOLLOWUP_DAYS * 86_400_000).toISOString();

  // Pull wechat marks older than the cutoff. Scope by rep when given.
  let q = supabase
    .from("brief_lookups")
    .select("lead_id, marked_by_rep_id, wechat_at, created_at, query")
    .eq("added_wechat", true)
    .not("marked_by_rep_id", "is", null)
    .not("lead_id", "is", null)
    .lte("wechat_at", cutoff)
    .order("wechat_at", { ascending: true })
    .limit(200);
  if (repId !== null) q = q.eq("marked_by_rep_id", repId);
  const { data: marks } = await q;
  if (!marks || marks.length === 0) return [];

  // Resolve lead titles + thread context in one query.
  const leadIds = Array.from(new Set(marks.map((m) => m.lead_id as string)));
  const { data: leads } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_email, thread_id")
    .in("id", leadIds);
  const leadById = new Map<string, { title: string | null; author_email: string | null; thread_id: string | null }>();
  for (const l of leads ?? []) {
    leadById.set(l.id as string, {
      title: l.title as string | null,
      author_email: l.author_email as string | null,
      thread_id: l.thread_id as string | null,
    });
  }

  // For each mark, check whether there's been any inbound on that
  // lead's thread since wechat_at. If yes, the rep is already in
  // conversation — skip. If no, this is a stale wechat that needs
  // a follow-up nudge.
  const out: StaleWechat[] = [];
  for (const m of marks) {
    const lead = leadById.get(m.lead_id as string);
    if (!lead?.thread_id) {
      // No thread linkage — we can't tell if there's been a reply.
      // Surface anyway; the rep can judge.
      const markedAt = (m.wechat_at as string) || (m.created_at as string);
      out.push({
        lead_id: m.lead_id as string,
        rep_id: m.marked_by_rep_id as number,
        marked_at: markedAt,
        recipient: (m.query as string | null) || lead?.author_email || null,
        lead_title: lead?.title ?? null,
        days_stale: Math.floor((Date.now() - new Date(markedAt).getTime()) / 86_400_000),
      });
      continue;
    }
    const markedAt = (m.wechat_at as string) || (m.created_at as string);
    const { count: inboundSince } = await supabase
      .from("inbound_emails")
      .select("*", { count: "exact", head: true })
      .eq("thread_id", lead.thread_id)
      .gte("created_at", markedAt);
    if ((inboundSince ?? 0) === 0) {
      out.push({
        lead_id: m.lead_id as string,
        rep_id: m.marked_by_rep_id as number,
        marked_at: markedAt,
        recipient: (m.query as string | null) || lead.author_email,
        lead_title: lead.title,
        days_stale: Math.floor((Date.now() - new Date(markedAt).getTime()) / 86_400_000),
      });
    }
  }
  return out.slice(0, 20);
}
