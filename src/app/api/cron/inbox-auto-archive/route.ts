// /api/cron/inbox-auto-archive — daily cleanup of stale admin_inbox rows.
//
// Two passes:
//   1. Auto-dismiss obvious SMOKE/test rows older than 1 day.
//   2. Auto-dismiss any 'new' row older than 14 days that wasn't acted on.
//      Logic: if admin didn't care after 2 weeks, it's noise. Mark dismissed
//      with rejected_reason='auto-archived (stale)' so it's clear.
//
// Doesn't touch 'request' kind from leon_uncertain — those are real
// admin asks, deserve to linger. Same for dynamic_tool / dynamic_write
// proposals — those have side effects bound to them.
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();

  // Pass 1: SMOKE rows (headline starts with SMOKE, [SMOKE], or 🧪 Hypothesis test)
  const { data: smokeRows } = await supabase
    .from("admin_inbox")
    .select("id, headline")
    .eq("status", "new")
    .lt("created_at", oneDayAgo)
    .or("headline.ilike.SMOKE%,headline.ilike.%[SMOKE]%,headline.ilike.%🧪 Hypothesis%,headline.ilike.%SMOKE-%,headline.ilike.❓ Leon 不确定: SMOKE%");
  const smokeIds = (smokeRows ?? []).map((r) => r.id);

  let smokeDismissed = 0;
  if (smokeIds.length > 0) {
    const { error, count } = await supabase
      .from("admin_inbox")
      .update({
        status: "dismissed",
        rejected_reason: "auto-archived (smoke / hypothesis-test artifact)",
        acted_at: new Date().toISOString(),
      }, { count: "exact" })
      .in("id", smokeIds);
    if (!error) smokeDismissed = count ?? 0;
  }

  // Pass 2: stale rows older than 14d, BUT skip ones that have side
  // effects bound (dynamic_tool / dynamic_write / guided_task /
  // doc_edit references in evidence) — those still need explicit decision.
  const { data: staleRows } = await supabase
    .from("admin_inbox")
    .select("id, evidence, kind")
    .eq("status", "new")
    .lt("created_at", fourteenDaysAgo);
  const safeIds: string[] = [];
  for (const r of staleRows ?? []) {
    const ev = (r.evidence ?? {}) as Record<string, unknown>;
    if (typeof ev.dynamic_tool_id === "string") continue;
    if (typeof ev.dynamic_write_id === "string") continue;
    if (typeof ev.guided_task_id === "string") continue;
    if (typeof ev.congress_debate_id === "string") continue;
    if (ev.source === "leon_uncertain") continue;  // real Q to admin, leave it
    safeIds.push(r.id);
  }
  let staleDismissed = 0;
  if (safeIds.length > 0) {
    const { error, count } = await supabase
      .from("admin_inbox")
      .update({
        status: "dismissed",
        rejected_reason: "auto-archived (14d no action)",
        acted_at: new Date().toISOString(),
      }, { count: "exact" })
      .in("id", safeIds);
    if (!error) staleDismissed = count ?? 0;
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    smoke_dismissed: smokeDismissed,
    stale_dismissed: staleDismissed,
    total: smokeDismissed + staleDismissed,
  });
}
