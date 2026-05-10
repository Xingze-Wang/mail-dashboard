import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { startWeeklyRun, driveToCompletion } from "@/lib/congress-stepwise";
import { after } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/congress/runs
 * Body: { kind: "weekly" }   // monthly + postmortem TBD
 *
 * Starts a stepwise congress run and returns the run id immediately.
 * Personas are advanced asynchronously via after() — the response
 * fires within ~1s so the UI can navigate to /congress/[id]/live and
 * watch personas land in real time.
 *
 * Why after() instead of synchronously running to completion: the
 * synchronous path takes 30-60s (7 personas × LLM latency); we'd
 * blow the 30s function budget AND block the UI from showing the
 * live view. Stepwise + after() = 1s response, deliberation continues
 * in the background, UI polls.
 *
 * Auth: any logged-in rep. Anyone can start a run. Synthesizer's
 * artifacts (tactical_proposals row, template draft) still go through
 * admin approval downstream so this isn't a privilege escalation.
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { kind?: string };
  const kind = body.kind ?? "weekly";
  if (kind !== "weekly") {
    return NextResponse.json(
      { error: `kind '${kind}' not supported yet (only 'weekly')` },
      { status: 400 },
    );
  }

  const runId = await startWeeklyRun();

  // Drive to completion in background. driveToCompletion is the
  // simple "step until status != running" loop. Each step is one LLM
  // call; for ~7 personas at ~5s each, total ~35s — well within the
  // after() worker budget.
  after(async () => {
    try {
      await driveToCompletion(runId);
    } catch (e) {
      console.error(`[congress/runs] driveToCompletion failed for ${runId}:`, e);
    }
  });

  return NextResponse.json({ run_id: runId, kind, status: "running" });
}

/**
 * GET /api/congress/runs
 *   ?status=running|completed|failed|all  (default 'running')
 *
 * Lists recent runs. Useful for debugging + a future "history" tab.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "running";

  let q = supabase
    .from("congress_runs")
    .select("id, kind, status, current_idx, started_at, completed_at, tactical_proposal_id, template_proposal_id")
    .order("started_at", { ascending: false })
    .limit(50);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data ?? [] });
}
