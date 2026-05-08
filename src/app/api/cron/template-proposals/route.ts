import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const maxDuration = 120;

/**
 * GET /api/cron/template-proposals
 *
 * Weekly congress-style scan that proposes template assignment changes
 * based on actual performance data. The output is rows in
 * email_templates with status='proposal' that admin reviews on
 * /templates/bench (PROPOSAL badge + Activate button) or /admin/inbox.
 *
 * Algorithm (intentionally simple for v1):
 *   1. For each segment (cn, overseas, edu): pull every email sent in
 *      the last 90 days where the recipient matches that segment.
 *   2. Bucket by template_id. Compute click rate per bucket.
 *   3. Filter to buckets with sample_size ≥ 30 (statistical floor —
 *      below this, click-rate noise dominates signal).
 *   4. Find the top-performer per segment.
 *   5. Compare to the current segment_default for that segment:
 *        - if no template has segment_default=segment, propose the
 *          top-performer
 *        - if the current segment_default IS the top-performer, no-op
 *        - otherwise, propose switching
 *
 * Idempotency: each proposal carries a deterministic dedup key in
 * proposed_evidence.dedup_key — re-running this cron with the same
 * underlying data produces the same key and we upsert into the same
 * row, NOT a duplicate. The key includes the recommended template id
 * AND the segment, so a NEW recommendation generates a NEW row (the
 * old one's still there, archived later by admin or by the next run
 * once it gets superseded by yet another better one).
 *
 * Note: this isn't a full A/B significance test — that's M3 of the
 * design doc. v1 is "rank by point estimate, gate on min sample size".
 * Wilson CI + significance testing comes later.
 *
 * Schedule: weekly (vercel.json). One run produces 0–3 proposal rows.
 */

interface BucketStats {
  templateId: string;
  templateName: string;
  sent: number;
  clicked: number;
  clickRate: number;
}

const SEGMENTS = ["cn", "overseas", "edu"] as const;
type Segment = typeof SEGMENTS[number];

const MIN_SAMPLE = 30; // statistical floor per segment×template

function classifySegment(email: string): Segment | null {
  const lower = (email ?? "").toLowerCase();
  if (lower.endsWith(".cn")) return "cn";
  if (lower.endsWith(".edu") || lower.endsWith(".edu.cn")) return "edu";
  if (lower) return "overseas";
  return null;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString();

  // ── Pull active+proposal templates (the candidates to recommend) ────
  // Archived templates are excluded — we won't propose reverting to a
  // template the admin specifically retired. Proposals are included
  // because a previous proposal might still be the best option.
  const { data: tpls } = await supabase
    .from("email_templates")
    .select("id, name, status, segment_default")
    .neq("status", "archived");
  const tplsById = new Map((tpls ?? []).map((t) => [t.id as string, t]));

  // ── Pull last 90 days of sends ──────────────────────────────────────
  const { data: emails } = await supabase
    .from("emails")
    .select("id, template_id, to")
    .gte("created_at", since90)
    .not("template_id", "is", null);

  // ── Bucket by (segment, template_id) ────────────────────────────────
  type Key = `${Segment}|${string}`;
  const buckets = new Map<Key, { sent: number; clicked: number }>();
  const recipientToEmail = new Map<string, string>(); // email_id → recipient
  const segOf = new Map<string, Segment>(); // email_id → segment
  const tplOf = new Map<string, string>(); // email_id → template_id

  for (const e of emails ?? []) {
    const seg = classifySegment(String(e.to ?? ""));
    if (!seg) continue;
    if (!tplsById.has(e.template_id as string)) continue; // template archived since send
    const k: Key = `${seg}|${e.template_id}`;
    const b = buckets.get(k) ?? { sent: 0, clicked: 0 };
    b.sent++;
    buckets.set(k, b);
    recipientToEmail.set(e.id as string, String(e.to ?? "").toLowerCase().trim());
    segOf.set(e.id as string, seg);
    tplOf.set(e.id as string, e.template_id as string);
  }

  // ── Pull click signal in chunks (postgrest URL-length cap) ──────────
  const emailIds = (emails ?? []).map((e) => e.id as string);
  const CHUNK = 150;
  for (let i = 0; i < emailIds.length; i += CHUNK) {
    const chunk = emailIds.slice(i, i + CHUNK);
    const { data: clicks } = await supabase
      .from("email_history")
      .select("email_id")
      .in("email_id", chunk)
      .eq("was_clicked", true);
    for (const r of clicks ?? []) {
      const eid = r.email_id as string;
      const seg = segOf.get(eid);
      const tid = tplOf.get(eid);
      if (!seg || !tid) continue;
      const k: Key = `${seg}|${tid}`;
      const b = buckets.get(k) ?? { sent: 0, clicked: 0 };
      b.clicked++;
      buckets.set(k, b);
    }
  }

  // ── Pick top performer per segment ──────────────────────────────────
  const proposals: Array<{
    segment: Segment;
    winner: BucketStats;
    runners: BucketStats[];
    currentDefault: string | null;
  }> = [];

  for (const seg of SEGMENTS) {
    const stats: BucketStats[] = [];
    for (const [key, b] of buckets) {
      const [s, tid] = key.split("|") as [Segment, string];
      if (s !== seg) continue;
      if (b.sent < MIN_SAMPLE) continue;
      const tpl = tplsById.get(tid);
      if (!tpl) continue;
      stats.push({
        templateId: tid,
        templateName: tpl.name as string,
        sent: b.sent,
        clicked: b.clicked,
        clickRate: b.sent > 0 ? b.clicked / b.sent : 0,
      });
    }
    if (stats.length === 0) continue;
    stats.sort((a, b) => b.clickRate - a.clickRate);
    const winner = stats[0];

    // Find current segment_default for this segment, if any.
    const currentDefault =
      (tpls ?? []).find((t) => t.segment_default === seg)?.id ?? null;
    const currentDefaultId = currentDefault as string | null;

    // No-op #1: current default is already the top performer.
    if (currentDefaultId === winner.templateId) continue;

    // No-op #2: only ONE template exists in this segment's data. The
    // ranking is technically valid but the proposal would just be
    // "switch to the only template you have", which is never useful
    // — it'd just create a clone of `global` tagged with a segment.
    // Wait until there's at least one alternative to propose against.
    if (stats.length < 2) continue;

    // No-op #3: top performer is essentially identical to the second
    // place. We require a meaningful click-rate gap before proposing
    // a switch. Without this guard, tiny n + tiny rate diff produces
    // proposals that are statistical noise. Threshold: winner's rate
    // must be at least 1.3x the runner-up's rate.
    const runnerUp = stats[1];
    const lift = runnerUp.clickRate > 0 ? winner.clickRate / runnerUp.clickRate : Infinity;
    if (lift < 1.3) continue;

    proposals.push({
      segment: seg,
      winner,
      runners: stats.slice(1, 4), // top 3 runners-up for context
      currentDefault: currentDefaultId,
    });
  }

  // ── Write proposals as new email_templates rows ─────────────────────
  // Each proposal row CLONES the winner template's content but flips
  // segment_default to the proposed segment. Status='proposal' so it
  // doesn't enter prod sends until admin promotes. dedup_hash via the
  // proposed_evidence.dedup_key field — re-running with same winner+
  // segment finds and updates the existing row.
  const created: Array<{ id: string; segment: Segment; winnerName: string }> = [];

  for (const p of proposals) {
    const dedupKey = `congress-segment-promote:${p.segment}:winner=${p.winner.templateId}`;

    // Look for existing proposal with this dedup_key.
    const { data: existing } = await supabase
      .from("email_templates")
      .select("id")
      .eq("status", "proposal")
      .eq("proposed_evidence->>dedup_key", dedupKey)
      .maybeSingle();

    // Pull the winner template's full content so the proposal carries
    // the actual format strings (admin can review them on /templates/bench).
    const { data: winnerFull } = await supabase
      .from("email_templates")
      .select(
        "subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format",
      )
      .eq("id", p.winner.templateId)
      .maybeSingle();
    if (!winnerFull) continue;

    const evidence = {
      dedup_key: dedupKey,
      sample_size: p.winner.sent,
      click_rate_winner: p.winner.clickRate,
      runners_up: p.runners.map((r) => ({
        template: r.templateName,
        sent: r.sent,
        click_rate: r.clickRate,
      })),
      current_segment_default: p.currentDefault,
      generated_at: new Date().toISOString(),
    };

    const reason =
      `Segment '${p.segment}': over the last 90 days, "${p.winner.templateName}" had click rate ` +
      `${(p.winner.clickRate * 100).toFixed(1)}% on ${p.winner.sent} sends — ` +
      `the top performer among templates with ≥${MIN_SAMPLE} sends in this segment. ` +
      (p.currentDefault
        ? `The current segment_default for '${p.segment}' is a different template; recommend switching.`
        : `No template currently carries segment_default='${p.segment}'; recommend setting one.`);

    if (existing) {
      // Refresh evidence + reason; don't touch status (admin may have
      // already acknowledged).
      await supabase
        .from("email_templates")
        .update({
          proposed_reason: reason,
          proposed_evidence: evidence,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      continue;
    }

    // Create a new proposal row. It's a clone of the winner with
    // segment_default set + status='proposal'. Admin can promote with
    // /api/templates/[id]/promote.
    const proposalName = `proposal_${p.segment}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${p.winner.templateName.slice(0, 20)}`;
    const { data: inserted } = await supabase
      .from("email_templates")
      .insert({
        name: proposalName,
        rep_id: null,
        active: true,
        status: "proposal",
        segment_default: p.segment,
        proposed_by: "congress",
        proposed_reason: reason,
        proposed_evidence: evidence,
        notes: `Auto-generated from /api/cron/template-proposals. Clone of "${p.winner.templateName}" tagged for segment='${p.segment}'.`,
        ...winnerFull,
      })
      .select("id")
      .single();
    if (inserted) {
      created.push({ id: inserted.id as string, segment: p.segment, winnerName: p.winner.templateName });
    }
  }

  // ── Mirror to admin_inbox so admin sees them on /admin/inbox too ────
  // Per the user's "congress应该对这个能提出好的意见" framing, these
  // recommendations should land in TWO places: the templates UI (with
  // the data and renderable preview) AND the inbox (the admin's
  // single pane for "things to review"). dedup_hash matches the
  // template's dedup_key so re-running doesn't re-notify.
  for (const c of created) {
    await supabase.from("admin_inbox").upsert(
      {
        kind: "idea",
        headline: `Template proposal: switch segment='${c.segment}' default to "${c.winnerName}"`,
        body:
          `Congress saw the data over the last 90 days and thinks the segment default for '${c.segment}' ` +
          `should change. Open /templates/bench?segment=${c.segment} to see the rendered output side-by-side, ` +
          `then click "Activate" on the proposal column to promote.`,
        evidence: { template_id: c.id, segment: c.segment },
        dedup_hash: `congress-segment-promote:${c.segment}:winner=${c.winnerName}`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "dedup_hash" },
    );
  }

  return NextResponse.json({
    ok: true,
    proposals_evaluated: proposals.length,
    proposals_created: created.length,
    created,
  });
}
