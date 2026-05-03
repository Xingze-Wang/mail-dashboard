// POST /api/tactical/[id]/decide?approved=1|0
//
// Admin clicks the link in their Lark DM (or hits this directly) to
// approve or reject a tactical_proposals row. On approve: we set
// ship_decision='approved' AND, if the change_spec is auto-applicable,
// we apply it AND set shipped_at=now() so Loop 3's Historian can grade
// it later.
//
// "Auto-applicable" change_spec kinds (handled here):
//   - template_phrase_swap: append the swap to global template's notes
//     field as guidance for the next draft generation
//   - subject_line_test: TBD (would need an A/B variant table)
//   - copy_edit: handled like template_phrase_swap
//   - routing_tweak: NOT auto-applied — too risky, requires human edit
//     to assignment.ts. We mark approved but leave shipped_at null and
//     DM admin "approved but needs manual code change."

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const session = gate.session;

  const { id } = await params;
  const url = new URL(req.url);
  const approved = url.searchParams.get("approved") === "1";

  const { data: prop, error: fetchErr } = await supabase
    .from("tactical_proposals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr || !prop) {
    return NextResponse.json({ error: "proposal not found" }, { status: 404 });
  }
  if (prop.ship_decision !== "pending") {
    return NextResponse.json({ error: `already decided: ${prop.ship_decision}` }, { status: 409 });
  }

  if (!approved) {
    await supabase.from("tactical_proposals").update({
      ship_decision: "rejected",
      decided_at: new Date().toISOString(),
      decided_by: session.email,
    }).eq("id", id);
    return NextResponse.json({ ok: true, decision: "rejected" });
  }

  // Approved — try to auto-apply change_spec
  const spec = prop.change_spec as { kind?: string; details?: Record<string, unknown> } | null;
  let shipped = false;
  let applyNote: string | null = null;

  if (spec?.kind === "template_phrase_swap" || spec?.kind === "copy_edit") {
    const details = spec.details ?? {};
    const note = `[congress-weekly ${new Date().toISOString().slice(0, 10)}] approved: ${JSON.stringify(details).slice(0, 300)}`;
    // Append to global template's notes so the drafter's prompt sees it
    const { data: tpl, error: tplErr } = await supabase
      .from("email_templates")
      .select("id, notes")
      .eq("name", "global")
      .maybeSingle();
    if (!tplErr && tpl) {
      const newNotes = (tpl.notes ?? "").trim() ? tpl.notes + "\n" + note : note;
      await supabase.from("email_templates").update({
        notes: newNotes,
        updated_at: new Date().toISOString(),
      }).eq("id", tpl.id);
      shipped = true;
      applyNote = `appended note to global template ${tpl.id}`;
    } else {
      applyNote = `global template not found — change approved but not auto-applied`;
    }
  } else if (spec?.kind === "routing_tweak") {
    applyNote = "routing changes are not auto-applied — requires manual edit to src/lib/assignment.ts";
  } else if (spec?.kind === "subject_line_test") {
    applyNote = "subject line A/B framework not built yet — change approved but not auto-applied";
  } else {
    applyNote = `unknown change_spec.kind: ${spec?.kind ?? "(none)"} — manual review required`;
  }

  await supabase.from("tactical_proposals").update({
    ship_decision: "approved",
    decided_at: new Date().toISOString(),
    decided_by: session.email,
    shipped_at: shipped ? new Date().toISOString() : null,
  }).eq("id", id);

  return NextResponse.json({
    ok: true,
    decision: "approved",
    shipped,
    note: applyNote,
  });
}

// GET handler — convenient for clicking the Lark link in a browser.
// Same auth required.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return POST(req, ctx);
}
