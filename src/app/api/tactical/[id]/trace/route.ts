// GET /api/tactical/[id]/trace — lifecycle events for one tactical proposal.
//
// No FK exists between tactical_proposals and prompt_drift_patterns; the
// congress evidence pack aggregates many signals. We reconstruct proximity via
// a 14-day window: JITR accepts whose decided_at falls within 14 days before
// proposed_at are treated as likely contributing signals.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export type TraceEventKind =
  | "proposed"
  | "jitr_accepted"
  | "jitr_dismissed"
  | "decided"
  | "measured";

export type TraceEvent = {
  kind: TraceEventKind;
  at: string;
  label: string;
  meta?: Record<string, string | number | null>;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data: proposal, error: propErr } = await supabase
    .from("tactical_proposals")
    .select("id, title, proposed_at, ship_decision, decided_at, shipped_at, grade, actual_lift")
    .eq("id", id)
    .maybeSingle();

  if (propErr || !proposal) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const proposedAt = new Date(proposal.proposed_at as string);
  const windowStart = new Date(proposedAt.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // JITR offers accepted/dismissed in the 14-day window before proposal surfaced
  const { data: jitrOffers } = await supabase
    .from("jitr_offers")
    .select("id, pattern_id, decision, decided_at, ai_phrase, sales_phrase, occurrence_count")
    .in("decision", ["accept", "dismiss"])
    .gte("decided_at", windowStart)
    .lte("decided_at", proposal.proposed_at as string)
    .order("decided_at", { ascending: true });

  type JitrRow = { id: string; pattern_id: number; decision: string; decided_at: string | null; ai_phrase: string; sales_phrase: string; occurrence_count: number };
  const events: TraceEvent[] = [];

  // Seed JITR events (deduplicated by pattern_id — take latest per pattern)
  const seenPatterns = new Map<string, JitrRow>();
  for (const offer of (jitrOffers ?? []) as JitrRow[]) {
    const existing = seenPatterns.get(String(offer.pattern_id));
    if (!existing || new Date(offer.decided_at ?? "") > new Date(existing.decided_at ?? "")) {
      seenPatterns.set(String(offer.pattern_id), offer);
    }
  }

  for (const offer of seenPatterns.values()) {
    events.push({
      kind: offer.decision === "accept" ? "jitr_accepted" : "jitr_dismissed",
      at: offer.decided_at ?? offer.pattern_id.toString(),
      label: offer.decision === "accept"
        ? `JITR accepted: "${offer.ai_phrase}" → "${offer.sales_phrase}"`
        : `JITR dismissed: "${offer.ai_phrase}"`,
      meta: {
        pattern_id: String(offer.pattern_id),
        occurrence_count: offer.occurrence_count as number,
      },
    });
  }

  // Proposal surfaced event
  events.push({
    kind: "proposed",
    at: proposal.proposed_at as string,
    label: "Proposal surfaced by Tactical Congress",
  });

  // Decision event
  if (proposal.decided_at) {
    events.push({
      kind: "decided",
      at: proposal.decided_at as string,
      label: `Decision: ${proposal.ship_decision ?? "pending"}`,
      meta: { decision: proposal.ship_decision as string },
    });
  }

  // Outcome event
  if (proposal.grade) {
    const lift = proposal.actual_lift as { sent?: number; open_rate?: number; click_rate?: number } | null;
    events.push({
      kind: "measured",
      at: proposal.shipped_at ?? proposal.decided_at ?? proposal.proposed_at as string,
      label: `Outcome graded: ${proposal.grade}`,
      meta: lift
        ? {
            sent: lift.sent ?? null,
            open_rate: lift.open_rate != null ? `${(lift.open_rate * 100).toFixed(2)}%` : null,
            click_rate: lift.click_rate != null ? `${(lift.click_rate * 100).toFixed(2)}%` : null,
          }
        : undefined,
    });
  }

  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return NextResponse.json({ proposalId: id, events });
}
