import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data } = await supabase.from("emails").select("status");
  const counts: Record<string, number> = {};
  for (const e of data || []) counts[e.status] = (counts[e.status] || 0) + 1;

  const { count: inbound } = await supabase
    .from("inbound_emails")
    .select("*", { count: "exact", head: true });

  const { count: webhooks } = await supabase
    .from("webhook_events")
    .select("*", { count: "exact", head: true });

  return NextResponse.json({
    sent: data?.length || 0,
    statuses: counts,
    inbound,
    webhooks,
  });
}
