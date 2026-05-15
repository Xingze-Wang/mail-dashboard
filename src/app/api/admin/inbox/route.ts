import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * GET  /api/admin/inbox?status=new|all  — list admin_inbox entries
 * POST /api/admin/inbox { id: uuid, status: 'acknowledged'|'dismissed'|'done' }
 *
 * Surface for migration 058's admin_inbox queue. This is the structured
 * "Leon thinks admin should see this" stream — distinct from
 * get_admin_alerts (derived from queries) and lark_messages (raw chat).
 *
 * Auth model is the same as every other admin route in this repo:
 * JWT for identity, but role is re-read from DB on every call (per
 * CLAUDE.md). A demoted admin loses access immediately even with a
 * still-valid JWT.
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

  const url = new URL(req.url);
  const filter = url.searchParams.get("status") ?? "new"; // new | all
  let query = supabase
    .from("admin_inbox")
    .select(
      "id, kind, headline, body, source_rep_id, evidence, status, rejected_reason, dedup_hash, created_at, updated_at, acted_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (filter !== "all") query = query.eq("status", filter);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Co-fetch source_rep_id → name map so the UI can display "from <rep>"
  // without a second round-trip per row. Cheap because there are at
  // most 200 rows × ≤10 unique reps.
  const repIds = Array.from(
    new Set((data ?? []).map((r) => r.source_rep_id).filter(Boolean) as number[]),
  );
  let repMap: Record<number, string> = {};
  if (repIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, name")
      .in("id", repIds);
    repMap = Object.fromEntries((reps ?? []).map((r) => [r.id, r.name]));
  }

  return NextResponse.json({ rows: data ?? [], rep_names: repMap });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    status?: string;     // legacy direct-status path (kept for old dashboard buttons)
    action?: string;     // new path — mirrors Lark card buttons (yes/no/skill/memory/both/neither)
  };
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  // New path: an action verb that matches the Lark card. Delegates to
  // processAdminInboxCardAction so web + Lark always produce the same
  // side effects (helper_learnings rows, status transitions, etc).
  // North-star rule: same outcome whether you click in /admin/inbox
  // or on the Lark card.
  if (body.action) {
    const allowedActions = new Set(["yes", "no", "skill", "memory", "both", "neither"]);
    if (!allowedActions.has(body.action)) {
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
    }
    // Look up admin's open_id so we can reuse the same dispatcher.
    const { data: me } = await supabase
      .from("sales_reps")
      .select("lark_open_id")
      .eq("id", admin.repId)
      .maybeSingle();
    const operatorOpenId = me?.lark_open_id;
    if (!operatorOpenId) {
      // Web admin without a Lark open_id — apply directly via a synthetic event.
      return NextResponse.json({ error: "admin missing lark_open_id; ask Xingze to link" }, { status: 400 });
    }
    const { processAdminInboxCardAction } = await import("@/lib/admin-inbox-card");
    const result = await processAdminInboxCardAction({
      event: {
        operator: { open_id: operatorOpenId },
        action: { value: { admin_inbox_action: body.action, inbox_id: body.id } },
      },
    });
    return NextResponse.json(result);
  }

  // Legacy path: direct status update.
  if (!body.status) {
    return NextResponse.json({ error: "status or action required" }, { status: 400 });
  }
  const allowed = new Set(["new", "acknowledged", "dismissed", "done"]);
  if (!allowed.has(body.status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const { error } = await supabase
    .from("admin_inbox")
    .update({
      status: body.status,
      acted_at: body.status === "new" ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
