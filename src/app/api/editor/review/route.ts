// POST /api/editor/review — runs the brand-editor on a proposed change
// and persists an editor_reviews row. body: { contract_id?, proposed_change, context? }

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { reviewContent } from "@/lib/editor-agent";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.proposed_change) {
    return NextResponse.json({ error: "proposed_change required" }, { status: 400 });
  }

  const verdict = await reviewContent({
    proposed_change: body.proposed_change,
    context: body.context,
  });

  const { data: row, error } = await supabase
    .from("editor_reviews")
    .insert({
      contract_id: body.contract_id ?? null,
      proposed_change: body.proposed_change,
      verdict: verdict.verdict,
      feedback: verdict.feedback,
      raw_output: verdict.raw_output,
      prompt_version: verdict.prompt_version,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ review_id: row.id, ...verdict });
}
