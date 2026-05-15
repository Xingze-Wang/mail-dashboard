// GET /api/admin/team-overview/<rep_id> — drill-down on a single rep.
// Returns: full brief + today's missions detailed + this week's
// activity stream + recent escalations + learnings about this rep.
// Used by the drill-in modal on /missions admin view.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

async function isAdmin(req: NextRequest): Promise<boolean> {
  const session = await requireSession(req);
  if (!session) return false;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  return rep?.role === "admin";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ rep_id: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: "admin only" }, { status: 403 });

  const { rep_id } = await params;
  const repId = Number(rep_id);
  if (!Number.isFinite(repId)) return NextResponse.json({ error: "invalid rep_id" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [
    repR,
    briefR,
    missionsR,
    recentEmailsR,
    escalationsR,
    learningsR,
    inboundR,
    wechatR,
  ] = await Promise.all([
    supabase.from("sales_reps").select("id, name, role, email, lark_open_id, trust_level").eq("id", repId).maybeSingle(),
    supabase.from("daily_rep_brief")
      .select("goal, reasoning, bullets, admin_overrode, admin_note, computed_at")
      .eq("rep_id", repId).eq("brief_date", today).maybeSingle(),
    supabase.from("v_mission_today")
      .select("*").eq("rep_id", repId).order("kind"),
    supabase.from("emails")
      .select("id, status, subject, recipient, created_at")
      .eq("actor_rep_id", repId)
      .gte("created_at", since7d)
      .order("created_at", { ascending: false })
      .limit(15),
    supabase.from("rep_questions")
      .select("raw_text, normalized, outcome, asked_at")
      .eq("rep_id", repId)
      .eq("outcome", "escalated")
      .gte("asked_at", since7d)
      .order("asked_at", { ascending: false })
      .limit(10),
    supabase.from("helper_learnings")
      .select("kind, body, confidence, created_at")
      .eq("scope_rep_id", repId)
      .is("superseded_at", null)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase.from("email_contact_history")
      .select("id, sender, subject, snippet, received_at")
      .eq("rep_id", repId)
      .eq("direction", "inbound")
      .gte("received_at", since7d)
      .order("received_at", { ascending: false })
      .limit(8),
    supabase.from("brief_lookups")
      .select("recipient, paper_title, wechat_at")
      .eq("marked_by_rep_id", repId)
      .eq("added_wechat", true)
      .gte("wechat_at", since7d)
      .order("wechat_at", { ascending: false })
      .limit(10),
  ]);

  if (!repR.data) return NextResponse.json({ error: "rep not found" }, { status: 404 });

  return NextResponse.json({
    today,
    rep: repR.data,
    brief: briefR.data,
    missions: missionsR.data ?? [],
    recent_emails: recentEmailsR.data ?? [],
    recent_escalations: escalationsR.data ?? [],
    learnings: learningsR.data ?? [],
    recent_inbound: inboundR.data ?? [],
    recent_wechat: wechatR.data ?? [],
  });
}
