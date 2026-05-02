import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

/**
 * Admin-only: bind a Lark open_id (or email) to one of the sales_reps rows.
 *
 * Two flows:
 *
 *  POST /api/lark/bind
 *   { rep_id: 2, lark_open_id: "ou_abc123..." }
 *   → writes lark_open_id onto sales_reps. Returns the updated row.
 *
 *  POST /api/lark/bind
 *   { rep_id: 2, lark_email: "chenyu@miracleplus.com" }
 *   → less reliable; the bot can still resolve via email lookup but only
 *     if Lark exposes the email field on the event (it doesn't always).
 *     Prefer open_id when possible. After the user sends one message via
 *     the Lark bot we can capture their open_id from lark_messages.raw.
 *
 * To find the Lark open_id of a colleague who hasn't messaged the bot yet,
 * use the Lark Open Platform's contact API (requires the contact:user:read
 * scope on your app); too app-specific to wire into this codebase. Easier:
 * have them DM the bot anything once, then the unbound message creates a
 * row in lark_messages with raw.event.sender.sender_id.open_id. Read that
 * column and POST it here.
 */

export async function POST(req: NextRequest) {
  const session = await requireAdmin(req);
  if (!session) return NextResponse.json({ error: "admin only" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const repId = Number(body.rep_id);
  const openId = typeof body.lark_open_id === "string" ? body.lark_open_id.trim() : null;
  const email = typeof body.lark_email === "string" ? body.lark_email.trim().toLowerCase() : null;

  if (!Number.isFinite(repId)) return NextResponse.json({ error: "rep_id required" }, { status: 400 });
  if (!openId && !email) return NextResponse.json({ error: "lark_open_id or lark_email required" }, { status: 400 });

  const { data: rep, error: repErr } = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id, lark_email")
    .eq("id", repId)
    .maybeSingle();
  if (repErr || !rep) return NextResponse.json({ error: "rep not found" }, { status: 404 });

  // If open_id supplied, check it isn't already bound to a different rep
  if (openId) {
    const { data: clash } = await supabase
      .from("sales_reps")
      .select("id, name")
      .eq("lark_open_id", openId)
      .neq("id", repId)
      .maybeSingle();
    if (clash) {
      return NextResponse.json({
        error: `open_id already bound to rep ${clash.name} (id ${clash.id})`,
      }, { status: 409 });
    }
  }

  const update: Record<string, string> = {};
  if (openId) update.lark_open_id = openId;
  if (email) update.lark_email = email;

  const { error: updErr } = await supabase
    .from("sales_reps")
    .update(update)
    .eq("id", repId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    rep: { id: rep.id, name: rep.name, ...update },
  });
}

/**
 * GET /api/lark/bind?orphans=1
 *   → list lark_messages whose sender open_id has no matching rep yet,
 *     so admin can match them up.
 */
export async function GET(req: NextRequest) {
  const session = await requireAdmin(req);
  if (!session) return NextResponse.json({ error: "admin only" }, { status: 401 });

  const url = new URL(req.url);
  if (url.searchParams.get("orphans")) {
    // distinct senders from lark_messages whose rep_id is null
    const { data: orphanRows } = await supabase
      .from("lark_messages")
      .select("raw, created_at")
      .is("rep_id", null)
      .order("created_at", { ascending: false })
      .limit(50);
    const seen = new Map<string, { open_id: string; sample_text: string; first_seen: string }>();
    for (const r of orphanRows ?? []) {
      const ev = (r.raw as { event?: { sender?: { sender_id?: { open_id?: string } }; message?: { content?: string } } })?.event;
      const oid = ev?.sender?.sender_id?.open_id;
      if (!oid || seen.has(oid)) continue;
      let sampleText = "";
      try {
        sampleText = JSON.parse(ev?.message?.content ?? "{}").text ?? "";
      } catch { /* ignore */ }
      seen.set(oid, { open_id: oid, sample_text: sampleText.slice(0, 80), first_seen: r.created_at });
    }
    return NextResponse.json({ orphans: [...seen.values()] });
  }

  // Default: list reps + their binding state
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, sender_email, role, active, lark_open_id, lark_email")
    .order("id");
  return NextResponse.json({ reps: reps ?? [] });
}
