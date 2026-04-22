import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { setConfig, getConfig } from "@/lib/system-config";

export const dynamic = "force-dynamic";

/**
 * POST /api/scorer/promote
 * Body: { runId: string }  — the scorer_runs.id to mark active.
 *
 * "Active" = system_config["active_scorer_run_id"] = { id, promoted_at, promoted_by }.
 * Backend code that needs to know which scorer is live reads this key.
 *
 * GET /api/scorer/promote — returns the currently active run's id + metadata.
 */

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const runId = body.runId as string | undefined;
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const { data: run, error } = await supabase
    .from("scorer_runs")
    .select("id, trained_at, cv_f1, cv_auc, n_samples")
    .eq("id", runId)
    .maybeSingle();
  if (error || !run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const ok = await setConfig("active_scorer_run_id", {
    id: run.id,
    promoted_at: new Date().toISOString(),
    promoted_by: gate.session.email,
    cv_f1: run.cv_f1,
    cv_auc: run.cv_auc,
    trained_at: run.trained_at,
  });
  if (!ok) return NextResponse.json({ error: "Failed to persist active model" }, { status: 500 });

  return NextResponse.json({ ok: true, runId, promotedAt: new Date().toISOString() });
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const value = await getConfig("active_scorer_run_id");
  return NextResponse.json({ active: value ?? null });
}
