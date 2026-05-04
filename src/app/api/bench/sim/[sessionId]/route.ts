// src/app/api/bench/sim/[sessionId]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export async function GET(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { sessionId } = await params;

  const [{ data: session }, { data: results }, { data: companies }] = await Promise.all([
    supabase.from("bench_sim_sessions").select("*").eq("id", sessionId).single(),
    supabase.from("bench_step_results").select("*").eq("session_id", sessionId).order("step").order("loop"),
    supabase.from("bench_companies").select("*"),
  ]);

  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ session, results: results ?? [], companies: companies ?? [] });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { sessionId } = await params;
  await supabase.from("bench_sim_sessions").delete().eq("id", sessionId);
  return NextResponse.json({ ok: true });
}
