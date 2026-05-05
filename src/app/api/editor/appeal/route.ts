// POST /api/editor/appeal — a company appeals an editor block, requesting admin override.
// body: { review_id, company_id, argument }

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.review_id || !body.company_id || !body.argument) {
    return NextResponse.json({ error: "review_id, company_id, argument required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("editor_appeals")
    .insert({
      review_id: body.review_id,
      company_id: body.company_id,
      argument: String(body.argument).slice(0, 2000),
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ appeal_id: data.id, status: "pending" });
}
