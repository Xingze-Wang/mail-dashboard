import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

interface RepSeed {
  name: string;
  sender_email: string;
  sender_name: string;
  wechat_id: string;
  active: boolean;
}

const SEEDS: RepSeed[] = [
  // Chenyu — wechat is a placeholder; replace via /settings.
  {
    name: "Chenyu",
    sender_email: "chenyu@compute.miracleplus.com",
    sender_name: "Chenyu",
    wechat_id: "chenyu_wechat_TBD",
    active: true,
  },
  // Ethan
  {
    name: "Ethan",
    sender_email: "ethan@compute.miracleplus.com",
    sender_name: "Ethan",
    wechat_id: "hnyhc5",
    active: true,
  },
];

/**
 * POST /api/migrate/add-ethan
 * One-shot migration: ensure Chenyu and Ethan are present in `sales_reps`.
 * Idempotent — looks up by wechat_id (or name as fallback) and skips if
 * the rep is already there. Safe to re-run.
 */
export async function POST() {
  const results: Array<{
    name: string;
    status: "created" | "exists" | "failed";
    id?: number;
    wechat_id?: string;
    error?: string;
  }> = [];

  for (const seed of SEEDS) {
    // Look up by wechat_id first, fall back to name
    const { data: byWechat } = await supabase
      .from("sales_reps")
      .select("id, name, wechat_id")
      .eq("wechat_id", seed.wechat_id)
      .maybeSingle();

    if (byWechat?.id) {
      results.push({
        name: seed.name,
        status: "exists",
        id: byWechat.id,
        wechat_id: byWechat.wechat_id,
      });
      continue;
    }

    const { data: byName } = await supabase
      .from("sales_reps")
      .select("id, name, wechat_id")
      .eq("name", seed.name)
      .maybeSingle();

    if (byName?.id) {
      results.push({
        name: seed.name,
        status: "exists",
        id: byName.id,
        wechat_id: byName.wechat_id,
      });
      continue;
    }

    const { data: created, error: insertError } = await supabase
      .from("sales_reps")
      .insert(seed)
      .select("id, name, wechat_id")
      .single();

    if (insertError) {
      results.push({
        name: seed.name,
        status: "failed",
        error: insertError.message,
      });
      continue;
    }

    results.push({
      name: seed.name,
      status: "created",
      id: created.id,
      wechat_id: created.wechat_id,
    });
  }

  // Report final state — the user wants to see all reps.
  const { data: allReps } = await supabase
    .from("sales_reps")
    .select("id, name, wechat_id, active")
    .order("id");

  const failed = results.filter((r) => r.status === "failed");
  return NextResponse.json(
    {
      ok: failed.length === 0,
      results,
      reps: allReps ?? [],
      hint: failed.length
        ? "Run migrations/003-add-ethan.sql in Supabase SQL Editor if inserts failed"
        : undefined,
    },
    { status: failed.length ? 500 : 200 },
  );
}
