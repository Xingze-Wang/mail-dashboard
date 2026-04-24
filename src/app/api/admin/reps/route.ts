import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/reps          list reps + per-rep activity counts
 * PATCH /api/admin/reps         body: { id, role: 'admin'|'senior'|'sales', active?: bool }
 *
 * Admin-only. Promotes/demotes rep tier and toggles active.
 */

interface RepRow {
  id: number;
  name: string;
  username: string | null;
  login_email: string | null;
  sender_email: string | null;
  role: string;
  active: boolean;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, username, login_email, sender_email, role, active, created_at")
    .order("id");

  // Per-rep activity over the last 30 days
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const repsArr = (reps ?? []) as RepRow[];

  // Count assignments per rep (existing pipeline_leads)
  const { data: assignedRows } = await supabase
    .from("pipeline_leads")
    .select("assigned_rep_id")
    .gte("created_at", since);
  const assignedByRep = new Map<number, number>();
  for (const r of assignedRows ?? []) {
    const id = r.assigned_rep_id as number | null;
    if (id !== null) assignedByRep.set(id, (assignedByRep.get(id) ?? 0) + 1);
  }

  // Count actual sends per rep — emails table, attribute by from address.
  const { data: emailRows } = await supabase
    .from("emails")
    .select("from")
    .gte("created_at", since)
    .in("status", ["delivered", "clicked", "sent", "replied"]);
  const sentByEmail = new Map<string, number>();
  for (const e of emailRows ?? []) {
    const m = (e.from as string | null)?.match(/<([^>]+)>/);
    const addr = (m ? m[1] : (e.from as string | null) ?? "").toLowerCase().trim();
    if (addr) sentByEmail.set(addr, (sentByEmail.get(addr) ?? 0) + 1);
  }

  // Count corrections submitted per rep (any type, last 30 days)
  let correctionsByEmail = new Map<string, { soft: number; hard: number }>();
  try {
    const { data: corrRows } = await supabase
      .from("lead_corrections")
      .select("corrected_by, severity")
      .gte("corrected_at", since);
    correctionsByEmail = new Map();
    for (const c of corrRows ?? []) {
      const em = (c.corrected_by as string | null)?.toLowerCase().trim() ?? "";
      if (!em) continue;
      const e = correctionsByEmail.get(em) ?? { soft: 0, hard: 0 };
      if ((c.severity as string) === "hard") e.hard++; else e.soft++;
      correctionsByEmail.set(em, e);
    }
  } catch {
    // table missing — leave empty
  }

  const out = repsArr.map((r) => {
    const senderEm = (r.sender_email ?? "").toLowerCase().trim();
    const loginEm = (r.login_email ?? r.username ?? "").toLowerCase().trim();
    const corrFromSender = correctionsByEmail.get(senderEm) ?? { soft: 0, hard: 0 };
    const corrFromLogin = correctionsByEmail.get(loginEm) ?? { soft: 0, hard: 0 };
    return {
      id: r.id,
      name: r.name,
      username: r.username,
      login_email: r.login_email,
      sender_email: r.sender_email,
      role: r.role,
      active: r.active,
      created_at: r.created_at,
      activity30d: {
        assigned: assignedByRep.get(r.id) ?? 0,
        sent: sentByEmail.get(senderEm) ?? 0,
        flagsSoft: corrFromSender.soft + corrFromLogin.soft,
        flagsHard: corrFromSender.hard + corrFromLogin.hard,
      },
    };
  });

  return NextResponse.json({ reps: out });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (typeof body.role === "string") {
    if (!["admin", "senior", "sales"].includes(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    updates.role = body.role;
  }
  if (typeof body.active === "boolean") updates.active = body.active;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("sales_reps")
    .update(updates)
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If the rep was deactivated, orphan their unsent queue so drafts
  // don't silently render under fallback identity ("Leo") on send.
  // We requeue those leads; the assignment config still routes them
  // back to this inactive rep (config is a separate source of truth),
  // so admin needs to update the config too if the deactivation is
  // permanent. Logging the count makes that obvious.
  let orphaned = 0;
  if (updates.active === false) {
    const { data: orphanRows } = await supabase
      .from("pipeline_leads")
      .update({
        status: "queued",
        draft_subject: null,
        draft_html: null,
        draft_original_subject: null,
        draft_original_html: null,
        draft_edit_distance: null,
      })
      .eq("assigned_rep_id", id)
      .in("status", ["ready", "drafting"])
      .select("id");
    orphaned = orphanRows?.length ?? 0;
  }

  return NextResponse.json({ ok: true, orphaned });
}
