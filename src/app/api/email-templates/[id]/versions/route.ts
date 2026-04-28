import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/email-templates/[id]/versions
 *
 * Returns history snapshots for one template, newest first. Each
 * snapshot is the row state immediately BEFORE the corresponding
 * edit (captured by the trg_email_templates_version_capture trigger
 * from migration 033).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(_req);
  if ("response" in gate) return gate.response;
  const { id } = await ctx.params;

  const { data, error } = await supabase
    .from("email_template_versions")
    .select("*")
    .eq("template_id", id)
    .order("edited_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ versions: data ?? [] });
}
