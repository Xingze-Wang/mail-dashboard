// GET /api/editor/queue — admin's pending review queue: blocked reviews + pending appeals.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const [{ data: blocked }, { data: appeals }] = await Promise.all([
    supabase.from("editor_reviews")
      .select("*")
      .eq("verdict", "block")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("editor_appeals")
      .select("*, review:editor_reviews(*), company:bench_companies(name, color)")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  return NextResponse.json({
    blocked: blocked ?? [],
    appeals: appeals ?? [],
  });
}
