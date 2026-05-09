import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/template-auto-promote
 *
 * Closes the proposal → outcome loop. Daily cron that reads production
 * click data and decides:
 *   - Approved-draft templates that BEAT their segment's active by
 *     ≥20% on click rate (n≥30 each side) → auto-promote to active +
 *     archive the loser.
 *   - Approved-draft templates that LOSE to their segment's active by
 *     ≥20% (n≥30 each side) → auto-archive the proposal (refuted).
 *   - Inconclusive → leave alone, accumulate more data.
 *
 * Why approved_draft only and not 'proposal' status: proposals haven't
 * been admin-reviewed yet. The two-stage approval (proposal →
 * approved_draft → active) means admin says 'prose is OK' first; the
 * cron just decides 'data agrees?'. Auto-promoting a raw proposal
 * would skip prose review.
 *
 * KNOWN GAP — read this before debugging "cron always returns no_op":
 *
 * `loadEffectiveTemplate` (src/lib/template-assembler.ts) filters
 * status='active' only. So `approved_draft` templates are INVISIBLE
 * to production sends — they accumulate ZERO clicks. This cron has
 * nothing to compare against until A/B traffic-splitting is wired
 * into loadEffectiveTemplate (route some % of segment traffic through
 * active and the rest through approved_draft when both exist for the
 * same segment).
 *
 * Until that ships, this cron's decisions will all be no_op (
 * "n_draft=0 < 30"). The mechanism here is correct; the input
 * pipeline isn't feeding it yet. Next step is A/B-aware
 * loadEffectiveTemplate — out of scope for this commit.
 *
 * Auth: Bearer CRON_SECRET. Schedule (vercel.json): daily 5:00 UTC.
 */

interface TplBucket {
  id: string;
  name: string;
  status: string;
  segment: string | null;
  sent: number;
  clicked: number;
}

const MIN_SAMPLE = 30;
const LIFT_THRESHOLD = 1.2; // 20% lift

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Pull templates we care about — active + approved_draft + proposal
  // (we touch only active/approved_draft for promotion/archive but
  // also report on proposals that have data).
  const { data: tpls } = await supabase
    .from("email_templates")
    .select("id, name, status, segment_default")
    .in("status", ["active", "approved_draft", "proposal"])
    .eq("active", true);

  if (!tpls || tpls.length === 0) {
    return NextResponse.json({ ok: true, evaluated: 0, decided: 0, note: "no eligible templates" });
  }
  const tplIds = tpls.map((t) => t.id as string);

  // Pull last-30d emails for those templates.
  const { data: emails } = await supabase
    .from("emails")
    .select("id, template_id")
    .gte("created_at", since30)
    .in("template_id", tplIds);

  // Click signal — chunked because of postgrest URL length cap on .in().
  const ids = (emails ?? []).map((e) => e.id as string);
  const clickedSet = new Set<string>();
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data: clicks } = await supabase
      .from("email_history")
      .select("email_id")
      .in("email_id", chunk)
      .eq("was_clicked", true);
    for (const c of clicks ?? []) clickedSet.add(c.email_id as string);
  }

  // Bucket by template_id.
  const buckets = new Map<string, TplBucket>();
  for (const t of tpls) {
    buckets.set(t.id as string, {
      id: t.id as string,
      name: t.name as string,
      status: t.status as string,
      segment: (t.segment_default as string | null) ?? null,
      sent: 0,
      clicked: 0,
    });
  }
  for (const e of emails ?? []) {
    const b = buckets.get(e.template_id as string);
    if (!b) continue;
    b.sent++;
    if (clickedSet.has(e.id as string)) b.clicked++;
  }

  // Group by segment so we can compare active vs approved_draft within
  // the same routing rule. NULL segment treated as its own bucket
  // (the global template lives there).
  const bySegment = new Map<string, TplBucket[]>();
  for (const b of buckets.values()) {
    const key = b.segment ?? "__GLOBAL__";
    const list = bySegment.get(key) ?? [];
    list.push(b);
    bySegment.set(key, list);
  }

  const decisions: Array<{
    action: "promote" | "archive_loser" | "archive_refuted" | "no_op";
    segment: string;
    promoted_id?: string;
    archived_id?: string;
    rate_a?: number;
    rate_b?: number;
    n_a?: number;
    n_b?: number;
    reason?: string;
  }> = [];

  for (const [segment, list] of bySegment) {
    const active = list.find((t) => t.status === "active");
    const draft = list.find((t) => t.status === "approved_draft");
    if (!active || !draft) {
      decisions.push({ action: "no_op", segment, reason: "no active+approved_draft pair" });
      continue;
    }
    if (active.sent < MIN_SAMPLE || draft.sent < MIN_SAMPLE) {
      decisions.push({
        action: "no_op", segment,
        n_a: active.sent, n_b: draft.sent,
        reason: `n_active=${active.sent} n_draft=${draft.sent} (<${MIN_SAMPLE})`,
      });
      continue;
    }
    const aRate = active.clicked / active.sent;
    const dRate = draft.clicked / draft.sent;
    const lift = aRate > 0 ? dRate / aRate : Infinity;

    if (lift >= LIFT_THRESHOLD) {
      // Promote draft → active, archive old active
      const tNow = new Date().toISOString();
      await supabase.from("email_templates").update({
        status: "active",
        updated_at: tNow,
      }).eq("id", draft.id);
      await supabase.from("email_templates").update({
        status: "archived",
        active: false,
        updated_at: tNow,
      }).eq("id", active.id);
      // Mirror to admin_inbox so admin sees the swap
      await supabase.from("admin_inbox").upsert({
        kind: "observation",
        headline: `Auto-promoted template for segment '${segment}': ${draft.name}`,
        body: `Approved-draft '${draft.name}' beat active '${active.name}' by ${((lift - 1) * 100).toFixed(0)}% click rate (n_draft=${draft.sent}, n_active=${active.sent}). Auto-archived '${active.name}' for the swap. Visit /templates/${draft.id}/inspect to review the new active.`,
        evidence: {
          source: "template-auto-promote",
          segment,
          promoted_id: draft.id,
          archived_id: active.id,
          rate_promoted: dRate,
          rate_archived: aRate,
          n_promoted: draft.sent,
          n_archived: active.sent,
        },
        dedup_hash: `auto-promote:${draft.id}`,
        updated_at: tNow,
      }, { onConflict: "dedup_hash" });
      decisions.push({
        action: "promote", segment,
        promoted_id: draft.id, archived_id: active.id,
        rate_a: aRate, rate_b: dRate,
        n_a: active.sent, n_b: draft.sent,
        reason: `lift=${lift.toFixed(2)}x ≥ ${LIFT_THRESHOLD}`,
      });
    } else if (lift <= 1 / LIFT_THRESHOLD) {
      // Draft refuted — archive it
      const tNow = new Date().toISOString();
      await supabase.from("email_templates").update({
        status: "archived",
        active: false,
        updated_at: tNow,
      }).eq("id", draft.id);
      await supabase.from("admin_inbox").upsert({
        kind: "observation",
        headline: `Refuted template proposal for segment '${segment}': ${draft.name}`,
        body: `Approved-draft '${draft.name}' lost to active '${active.name}' by ${((1 - lift) * 100).toFixed(0)}% click rate (n_draft=${draft.sent}, n_active=${active.sent}). Auto-archived. The hypothesis behind this proposal was wrong; the next congress round will know.`,
        evidence: {
          source: "template-auto-promote",
          segment,
          archived_id: draft.id,
          kept_active_id: active.id,
          rate_archived: dRate,
          rate_kept: aRate,
          n_archived: draft.sent,
          n_kept: active.sent,
        },
        dedup_hash: `auto-refute:${draft.id}`,
        updated_at: tNow,
      }, { onConflict: "dedup_hash" });
      decisions.push({
        action: "archive_refuted", segment,
        archived_id: draft.id,
        rate_a: aRate, rate_b: dRate,
        n_a: active.sent, n_b: draft.sent,
        reason: `lift=${lift.toFixed(2)}x ≤ ${(1 / LIFT_THRESHOLD).toFixed(2)}x`,
      });
    } else {
      decisions.push({
        action: "no_op", segment,
        rate_a: aRate, rate_b: dRate,
        n_a: active.sent, n_b: draft.sent,
        reason: `lift=${lift.toFixed(2)}x in inconclusive band`,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    evaluated: bySegment.size,
    decided: decisions.filter((d) => d.action !== "no_op").length,
    decisions,
  });
}
