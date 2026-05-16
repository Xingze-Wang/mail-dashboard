import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";
import { getResendFunnel } from "@/lib/resend-funnel";
import { getRep } from "@/lib/assignment";
import { countLeads, countLeadsByStatus } from "@/lib/canonical-counts";

/**
 * GET /api/metrics/me
 *
 * Per-rep Overview metrics for sales. Counts from pipeline_leads filtered
 * by assigned_rep_id. Complements /api/metrics (global email funnel) —
 * sales see *their* pipeline slice; admin keeps seeing the global view.
 *
 * Historical note: emails sent before the assigned_rep_id column existed
 * do not belong to anyone in particular — we treat Leo (id=1) as the
 * historical owner, so his per-rep view will look sparse unless he runs
 * /api/metrics too. The overview page handles that branch client-side.
 */
export async function GET(req: NextRequest) {
  const session = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repId = session.repId;

  // `sent` = any CONTACTED_LEAD_STATUSES row assigned to this rep.
  // Includes 'sent' and 'replied' — a reply is a later phase of the
  // same send, not a displacement. Previously reps saw their sent count
  // drop when replies came in. Now aligned with every other place in
  // the app that answers "has this rep contacted this researcher?"
  // via @/lib/status.ts. (WeChat conversions live entirely in
  // brief_lookups; see status.ts header note on the removed
  // 'wechat_added' value.)
  // One canonical-counts round trip — `countLeadsByStatus` returns the
  // full status breakdown PLUS `contacted` (sum of CONTACTED_LEAD_STATUSES)
  // and `total`. Cheaper than the 4 separate count queries this used to
  // do, AND uses the exact same primitive as every other "how many
  // ${status} leads" surface on the site.
  const { byStatus, contacted, total } = await countLeadsByStatus({ repId });
  const assigned = total;
  const ready = byStatus.ready;
  const sent = contacted;
  const replied = byStatus.replied;
  const sentCount = sent;

  // WeChat conversions — attributed to WHOEVER MARKED the row (the
  // rep who clicked "Added on WeChat"), not to the lead's owner.
  // Previously this scoped by the lead's assigned_rep_id, which
  // inflated Leo's count with every historical conversion marked
  // against a Leo-owned lead — even when Chenyu was actually the
  // rep who took the WeChat contact. marked_by_rep_id (migration 012)
  // is the canonical field.
  //
  // Pre-migration-012 rows have marked_by_rep_id=null — their
  // attribution is genuinely unknown, so they're excluded from every
  // per-rep count. Admin sees them separately in a "legacy
  // unattributed" bucket (not surfaced yet; rows still exist in DB).
  //
  // DISTINCT by lead_id so a repeat click on the same lead counts once.
  let wechat = 0;
  {
    const { data: convRows } = await supabase
      .from("brief_lookups")
      .select("lead_id")
      .eq("added_wechat", true)
      .eq("marked_by_rep_id", repId)
      .not("lead_id", "is", null);
    if (Array.isArray(convRows)) {
      const distinct = new Set<string>();
      for (const r of convRows) {
        const id = r.lead_id as string | null;
        if (id) distinct.add(id);
      }
      wechat = distinct.size;
    }
  }

  // Live funnel from Resend — gives us the ACTUAL email-level sent
  // count for this rep. The pipeline-level `sentCount` above only
  // reflects leads that went through /api/pipeline/send; historical
  // and ad-hoc sends (via /api/send or before the pipeline existed)
  // never landed in pipeline_leads. Using pipeline-sent as the lead-
  // rate denominator inflates the rate by 30x.
  let resendSent = 0;
  try {
    const rep = await getRep(repId);
    if (rep?.sender_email) {
      const funnel = await getResendFunnel({ fromContains: rep.sender_email, timeBudgetMs: 6000 });
      resendSent = funnel.totalSent;
    }
  } catch {
    // If Resend is down, fall back to pipeline-sent (wrong but non-zero).
    resendSent = sentCount;
  }

  // Lead rate uses Resend-actual as denominator — if we've emailed 1000
  // people and 30 added WeChat, that's 3%, not (wechat / pipeline_sent).
  const rateDenominator = resendSent > 0 ? resendSent : sentCount;

  return NextResponse.json({
    repId,
    repName: session.repName,
    assigned: assigned ?? 0,
    ready: ready ?? 0,
    sent: sentCount, // pipeline-level (unchanged — that's what the Sent card shows)
    resendSent, // live email count from Resend (for downstream rate math)
    replied: replied ?? 0,
    wechat,
    leadRate: rateDenominator > 0 ? ((wechat / rateDenominator) * 100).toFixed(1) : "0.0",
  });
}
