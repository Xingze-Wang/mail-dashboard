import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { setConfig } from "@/lib/system-config";

export const dynamic = "force-dynamic";

/**
 * POST /api/scorer/promote-latest
 *
 * Called by the train-scorer GH Action when auto_promote=true. Auth is via
 * a shared bearer token (SCORER_TRAIN_TOKEN env on both sides) because the
 * action can't carry an admin session cookie.
 */
export async function POST(req: NextRequest) {
  const token = process.env.SCORER_TRAIN_TOKEN;
  const auth = req.headers.get("authorization");
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: latest } = await supabase
    .from("scorer_runs")
    .select("id, trained_at, cv_f1, cv_auc, n_samples")
    .order("trained_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return NextResponse.json({ error: "No scorer runs found" }, { status: 404 });

  const ok = await setConfig("active_scorer_run_id", {
    id: latest.id,
    promoted_at: new Date().toISOString(),
    promoted_by: "github-action",
    cv_f1: latest.cv_f1,
    cv_auc: latest.cv_auc,
    trained_at: latest.trained_at,
  });
  if (!ok) return NextResponse.json({ error: "Failed to persist" }, { status: 500 });
  return NextResponse.json({ ok: true, runId: latest.id });
}
