// GET  /api/rep-profiles → list all rep operating profiles (admin)
// POST /api/rep-profiles → admin manual recompute trigger

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { recomputeAllRepProfiles } from "@/lib/rep-profile";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data } = await supabase
    .from("rep_operating_profile")
    .select("*, rep:sales_reps(name, sender_name)")
    .order("recomputed_at", { ascending: false });
  return NextResponse.json({ profiles: data ?? [] });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const out = await recomputeAllRepProfiles({ lookbackDays: body.lookbackDays ?? 90 });
  return NextResponse.json(out);
}
