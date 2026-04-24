import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/proactive-signals
 *
 * Scans per-rep activity against a set of hard-coded signal rules.
 * When a rule trips, writes a JSON blob into that rep's
 * `helper_rep_state.pending_chime_in` — the helper surfaces it the
 * next time they open the chat (pull-style, never auto-opens).
 *
 * v1 rules: just one.
 *   1. voice_capture_offer — rep has sent ≥5 leads with
 *      draft_edit_distance > HEAVY_EDIT_THRESHOLD in the last 7 days.
 *      Threshold matches /api/drift/disagreement's EDIT_HEAVY=200 so
 *      "heavy editor" is defined consistently across the app.
 *
 * Scheduled via Vercel cron (see vercel.json). Bearer $CRON_SECRET
 * auth, same contract as /api/cron.
 *
 * Fail-quiet: per-rep errors don't abort the scan; the report
 * lists which reps tripped, which didn't, and which errored.
 */

const HEAVY_EDIT_THRESHOLD = 200;
const MIN_HEAVY_EDITS = 5;
const LOOKBACK_DAYS = 7;

interface PendingChimeIn {
  type: "voice_capture_offer";
  edit_count: number;
  window_days: number;
  detected_at: string;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: reps, error: repsErr } = await supabase
    .from("sales_reps")
    .select("id, name, active")
    .eq("active", true);
  if (repsErr) {
    return NextResponse.json({ error: repsErr.message }, { status: 500 });
  }

  const report: Array<{ rep_id: number; rep_name: string; heavy_edits: number; chime_in: string | null; error?: string }> = [];

  for (const rep of reps ?? []) {
    try {
      const { count, error: countErr } = await supabase
        .from("pipeline_leads")
        .select("*", { count: "exact", head: true })
        .eq("assigned_rep_id", rep.id)
        .eq("status", "sent")
        .gte("sent_at", cutoff)
        .gt("draft_edit_distance", HEAVY_EDIT_THRESHOLD);
      if (countErr) throw countErr;
      const heavyEdits = count ?? 0;

      if (heavyEdits >= MIN_HEAVY_EDITS) {
        // Don't overwrite an unclaimed pending chime-in of the same
        // type — the rep hasn't opened the chat yet, no point re-
        // firing. Do overwrite if the existing one is a different
        // type (this rule wins v1; when we have more rules we'll
        // need a proper priority ordering).
        const { data: existing } = await supabase
          .from("helper_rep_state")
          .select("pending_chime_in")
          .eq("rep_id", rep.id)
          .maybeSingle();
        const existingType = (existing?.pending_chime_in as PendingChimeIn | null)?.type ?? null;
        if (existingType === "voice_capture_offer") {
          report.push({ rep_id: rep.id, rep_name: rep.name, heavy_edits: heavyEdits, chime_in: "already_pending" });
          continue;
        }

        const chimeIn: PendingChimeIn = {
          type: "voice_capture_offer",
          edit_count: heavyEdits,
          window_days: LOOKBACK_DAYS,
          detected_at: new Date().toISOString(),
        };

        await supabase
          .from("helper_rep_state")
          .upsert({
            rep_id: rep.id,
            pending_chime_in: chimeIn,
            updated_at: new Date().toISOString(),
          }, { onConflict: "rep_id" });

        report.push({ rep_id: rep.id, rep_name: rep.name, heavy_edits: heavyEdits, chime_in: "voice_capture_offer" });
      } else {
        report.push({ rep_id: rep.id, rep_name: rep.name, heavy_edits: heavyEdits, chime_in: null });
      }
    } catch (err) {
      report.push({
        rep_id: rep.id,
        rep_name: rep.name,
        heavy_edits: 0,
        chime_in: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    thresholds: { heavy_edit_distance: HEAVY_EDIT_THRESHOLD, min_heavy_edits: MIN_HEAVY_EDITS, lookback_days: LOOKBACK_DAYS },
    report,
  });
}
