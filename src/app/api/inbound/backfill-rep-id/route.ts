import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { resolveInboundRepId } from "@/lib/inbound-attribution";

// One-shot backfill: re-resolve rep_id for inbound_emails rows where it's
// currently NULL. Pre-fix writes (active=true filter, substring bug) left
// many rows without attribution, so they don't appear in the right
// rep's inbox even though the resolver would now pin them correctly.
//
// Admin-only. Runs in batches of 100; call repeatedly to drain.
export const maxDuration = 120;
const BATCH = 100;

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: rows } = await supabase
    .from("inbound_emails")
    .select("id, to, thread_id")
    .is("rep_id", null)
    .order("created_at", { ascending: false })
    .limit(BATCH);

  if (!rows || rows.length === 0) {
    return NextResponse.json({ updated: 0, remaining: 0 });
  }

  let updated = 0;
  let stillNull = 0;
  for (const row of rows) {
    try {
      const repId = await resolveInboundRepId(
        row.to as string | null,
        row.thread_id as string | null,
      );
      if (repId === null) {
        stillNull++;
        continue;
      }
      const { error } = await supabase
        .from("inbound_emails")
        .update({ rep_id: repId })
        .eq("id", row.id);
      if (!error) updated++;
    } catch (err) {
      console.error("inbound backfill row failed", { id: row.id, err: String(err) });
    }
  }

  const { count: remaining } = await supabase
    .from("inbound_emails")
    .select("*", { count: "exact", head: true })
    .is("rep_id", null);

  return NextResponse.json({
    processed: rows.length,
    updated,
    stillUnresolved: stillNull,
    remaining: remaining ?? 0,
  });
}
