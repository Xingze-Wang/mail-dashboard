import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getMpConversionMatrix } from "@/lib/canonical-counts";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/missions
 *
 * Returns proposed team_focus rows + proposed missions grouped by
 * week_starting + rep, so admin can approve a whole week at once.
 *
 * Auth: admin only.
 */

async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { data: focuses } = await supabase
    .from("team_focus")
    .select("id, week_starting, theme, rationale, set_by, status, congress_run_id, created_at")
    .order("week_starting", { ascending: false })
    .limit(20);

  const { data: missions } = await supabase
    .from("missions")
    .select("id, rep_id, due_date, kind, target, scope, description, generated_by, team_focus_id, status, created_at")
    .in("status", ["proposed", "active"])
    .order("due_date", { ascending: true })
    .limit(500);

  const repIds = [...new Set((missions ?? []).map((m) => m.rep_id as number))];
  const repName = new Map<number, string>();
  if (repIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, sender_name, name, role")
      .in("id", repIds);
    for (const r of reps ?? []) {
      repName.set(
        r.id as number,
        ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${r.id}`),
      );
    }
  }

  // Per-rep MP conversion slice (last 30d). Mirrors the home-page rep
  // card trio model so any downstream consumer (Leon, admin dashboards
  // pulling /api/admin/missions) can show "rep N: registered/submitted/
  // wechat" without re-querying. Soft-fail to keep the page resilient
  // when MP sync is degraded — admin can still approve / reject focuses.
  const mp30dByRep = new Map<
    number,
    { registered: number; submitted: number; wechat: number; total_emailed: number; matched: number }
  >();
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const matrix = await getMpConversionMatrix({ since });
    for (const r of matrix.perRep ?? []) {
      mp30dByRep.set(r.rep_id, {
        // Monotone "registered" includes submitted, matching the home page.
        registered: r.registered + r.submittedApplication,
        submitted: r.submittedApplication,
        wechat: r.wechatAdded,
        total_emailed: r.totalEmailed,
        matched: r.matched,
      });
    }
  } catch (err) {
    console.warn(
      "[admin/missions] mp matrix failed",
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({
    focuses: focuses ?? [],
    missions: (missions ?? []).map((m) => ({
      ...m,
      rep_name: repName.get(m.rep_id as number) ?? `rep#${m.rep_id}`,
      mp_30d: mp30dByRep.get(m.rep_id as number) ?? null,
    })),
  });
}

/**
 * POST /api/admin/missions
 *
 * Body shapes (one of):
 *   { action: "approve_focus", focus_id }
 *   { action: "approve_missions", week_starting }   // approve all proposed for week
 *   { action: "reject_focus", focus_id }
 *   { action: "reject_missions", week_starting }
 *
 * Bulk approval makes admin's job tractable: a synthesizer-emitted
 * week with 5 reps × 5 days × 2 mission kinds = 50 mission rows;
 * admin shouldn't have to click 50 times.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    focus_id?: string;
    week_starting?: string;
    // create_mission payload
    rep_id?: number;
    due_date?: string;
    kind?: string;
    target?: number;
    description?: string | null;
  };

  const stamp = {
    approved_at: new Date().toISOString(),
    approved_by_rep_id: admin.repId,
  };

  if (body.action === "approve_focus" && body.focus_id) {
    // Approve focus → demote any other active focus for the same week first.
    const { data: focus } = await supabase
      .from("team_focus")
      .select("week_starting")
      .eq("id", body.focus_id)
      .maybeSingle();
    if (!focus) return NextResponse.json({ error: "focus not found" }, { status: 404 });

    await supabase
      .from("team_focus")
      .update({ status: "archived" })
      .eq("week_starting", focus.week_starting)
      .eq("status", "active");
    const { error } = await supabase
      .from("team_focus")
      .update({ status: "active", ...stamp })
      .eq("id", body.focus_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "reject_focus" && body.focus_id) {
    const { error } = await supabase
      .from("team_focus")
      .update({ status: "rejected", ...stamp })
      .eq("id", body.focus_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "approve_missions" && body.week_starting) {
    // Approve every proposed mission whose due_date falls in the week
    // starting on body.week_starting.
    const start = body.week_starting;
    const end = new Date(start + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + 7);
    const endIso = end.toISOString().slice(0, 10);
    const { error } = await supabase
      .from("missions")
      .update({ status: "active", ...stamp })
      .gte("due_date", start)
      .lt("due_date", endIso)
      .eq("status", "proposed");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "reject_missions" && body.week_starting) {
    const start = body.week_starting;
    const end = new Date(start + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + 7);
    const endIso = end.toISOString().slice(0, 10);
    const { error } = await supabase
      .from("missions")
      .update({ status: "rejected", ...stamp })
      .gte("due_date", start)
      .lt("due_date", endIso)
      .eq("status", "proposed");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // ─── Direct admin authoring — bypass the propose→approve flow when
  // admin knows what they want. Inserts a mission row as `status='active'`
  // immediately so the rep sees it on /missions today.
  // ───
  if (body.action === "create_mission") {
    const repId = body.rep_id;
    const dueDate = body.due_date ?? new Date().toISOString().slice(0, 10);
    const kind = body.kind;
    const target = body.target;
    if (!repId || !kind || !target || target <= 0) {
      return NextResponse.json(
        { error: "create_mission requires rep_id, kind, target>0" },
        { status: 400 },
      );
    }
    const { data, error } = await supabase
      .from("missions")
      .insert({
        rep_id: repId,
        due_date: dueDate,
        kind,
        target,
        description: body.description ?? null,
        status: "active",
        generated_by: "admin",
        approved_at: stamp.approved_at,
        approved_by_rep_id: stamp.approved_by_rep_id,
      })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: data!.id });
  }

  // ─── Bulk-approve every proposed mission whose due_date == today.
  // Different from approve_missions(week_starting) — this lets admin
  // approve just today's queue from the team-overview screen without
  // computing a week-starting date.
  // ───
  if (body.action === "approve_today_missions") {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("missions")
      .update({ status: "active", ...stamp })
      .eq("due_date", today)
      .eq("status", "proposed")
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, approved: data?.length ?? 0 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
