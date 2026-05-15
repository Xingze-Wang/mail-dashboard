// POST /api/admin/inbox/bulk-dismiss { ids: string[] | filter: {...} }
// Admin-only. Bulk-dismiss many admin_inbox rows in one call.
// Two modes:
//   - {ids: [...]} — explicit list (from the UI checkbox flow)
//   - {filter: {older_than_days?, source?, headline_starts_with?}} — server-side filter
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

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

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: "admin only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as {
    ids?: string[];
    filter?: {
      older_than_days?: number;
      source?: string;
      headline_starts_with?: string;
    };
  };

  if (body.ids && body.ids.length > 0) {
    const { error, count } = await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", acted_at: new Date().toISOString() }, { count: "exact" })
      .in("id", body.ids.slice(0, 200))
      .eq("status", "new");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, dismissed: count ?? 0 });
  }

  if (body.filter) {
    let q = supabase.from("admin_inbox").select("id, headline, evidence, created_at").eq("status", "new");
    if (typeof body.filter.older_than_days === "number") {
      const cutoff = new Date(Date.now() - body.filter.older_than_days * 86_400_000).toISOString();
      q = q.lt("created_at", cutoff);
    }
    if (body.filter.headline_starts_with) {
      q = q.ilike("headline", `${body.filter.headline_starts_with}%`);
    }
    const { data: matches } = await q;
    let toDismiss = matches ?? [];
    if (body.filter.source) {
      toDismiss = toDismiss.filter((r) => {
        const ev = (r.evidence ?? {}) as Record<string, unknown>;
        return ev.source === body.filter!.source;
      });
    }
    if (toDismiss.length === 0) return NextResponse.json({ ok: true, dismissed: 0 });
    const ids = toDismiss.map((r) => r.id);
    const { error, count } = await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", acted_at: new Date().toISOString() }, { count: "exact" })
      .in("id", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, dismissed: count ?? 0, ids: ids.slice(0, 50) });
  }

  return NextResponse.json({ error: "ids or filter required" }, { status: 400 });
}
