import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";
import {
  getAllEffectiveQuotas,
  setStandingQuota,
  setOverride,
} from "@/lib/quota-store";
import { normalizePerPool } from "@/lib/pool-types";
import { getMpConversionMatrix } from "@/lib/canonical-counts";

export const dynamic = "force-dynamic";

/** GET: return current standing quotas + reps. */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const reps = await supabase
    .from("sales_reps")
    .select("id, name, sender_email, role, active, created_at")
    .eq("active", true)
    .order("id");
  if (reps.error) {
    return NextResponse.json({ error: reps.error.message }, { status: 500 });
  }

  const quotas = await getAllEffectiveQuotas(today);
  const quotaByRep = new Map(quotas.map((q) => [q.rep_id, q]));

  // Attach per-rep MP conversion slice (last 30d) so the admin quota UI
  // has the same registered/submitted/wechat trio the home page shows
  // — admin can pick quotas with conversion context inline, no extra
  // round trip. Soft-fail keeps the quota editor usable even when MP
  // sync is degraded.
  const mp30dByRep = new Map<
    number,
    { registered: number; submitted: number; wechat: number; total_emailed: number; matched: number }
  >();
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const matrix = await getMpConversionMatrix({ since });
    for (const r of matrix.perRep ?? []) {
      mp30dByRep.set(r.rep_id, {
        registered: r.registered + r.submittedApplication,
        submitted: r.submittedApplication,
        wechat: r.wechatAdded,
        total_emailed: r.totalEmailed,
        matched: r.matched,
      });
    }
  } catch (err) {
    console.warn(
      "[admin/missions/quotas] mp matrix failed",
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({
    today,
    reps: (reps.data || []).map((r) => ({
      rep_id: r.id,
      name: r.name,
      sender_email: r.sender_email,
      role: r.role,
      created_at: r.created_at,
      quota: quotaByRep.get(r.id) ?? null,
      mp_30d: mp30dByRep.get(r.id) ?? null,
    })),
  });
}

/** POST: upsert standing quota OR override.
 *  Body for standing:  { rep_id, per_pool, direction_priority? }
 *  Body for override:  { rep_id, due_date, per_pool, reason? }
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const repId = Number(body.rep_id);
  if (!Number.isFinite(repId) || repId <= 0) {
    return NextResponse.json({ error: "rep_id required" }, { status: 400 });
  }
  const perPool = normalizePerPool(body.per_pool);

  if (body.due_date && typeof body.due_date === "string") {
    await setOverride(repId, body.due_date, {
      per_pool: perPool,
      reason: typeof body.reason === "string" ? body.reason : null,
      created_by_rep_id: session.repId,
    });
    return NextResponse.json({ ok: true, mode: "override", rep_id: repId, due_date: body.due_date });
  }

  const directionPriority = Array.isArray(body.direction_priority)
    ? body.direction_priority.filter((s): s is string => typeof s === "string")
    : undefined;
  await setStandingQuota(repId, {
    per_pool: perPool,
    direction_priority: directionPriority,
    updated_by_rep_id: session.repId,
  });
  return NextResponse.json({ ok: true, mode: "standing", rep_id: repId });
}
