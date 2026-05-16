// src/app/api/cron/propose-templates-to-reps/route.ts
//
// Picks up email_templates rows where:
//   status = 'proposal'
//   rep_id IS NOT NULL                  (rep-targeted, not org-wide)
//   proposed_to_rep_at IS NULL          (never sent OR last send was
//                                        reset for re-nudge — see below)
//   rep_approved_at IS NULL             (rep hasn't already approved)
//   created_at >= now() - 14 days       (don't resurrect stale ones)
//
// For each, sends a Lark card via sendRepTemplateProposalCard. On
// success, stamps proposed_to_rep_at = NOW().
//
// Re-nudge: rows where proposed_to_rep_at < now() - 72h AND
// rep_approved_at IS NULL AND created_at > now() - 7d get a second
// card (idempotent — Lark dedups by message body within a chat).
//
// Auto-archive: rows where proposed_to_rep_at < now() - 7d AND
// rep_approved_at IS NULL get status='archived',
// rep_rejection_reason='Timed out — no rep response in 7d'.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { sendRepTemplateProposalCard } from "@/lib/rep-template-card";
import { loadEffectiveTemplate } from "@/lib/template-assembler";

export const preferredRegion = ["hkg1"];
export const maxDuration = 90;

function buildDiffSummary(_proposed: Record<string, unknown>, _current: Record<string, unknown> | null): string {
  // MVP: show the first ~400 chars of full_html_override (or
  // subject_override) stripped of HTML tags. A real diff library can
  // come later; the rep mostly wants to see "what's the new opening line."
  const proposedHtml = (_proposed.full_html_override as string | null) ?? "";
  if (!proposedHtml) return "(no diff to show)";
  return proposedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

interface PerRow {
  template_id: string;
  rep_id: number;
  action: "sent" | "renudged" | "archived" | "error";
  error?: string;
}

async function run(): Promise<{ ran_at: string; per_row: PerRow[] }> {
  const ran_at = new Date().toISOString();
  const per_row: PerRow[] = [];
  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const threeDaysAgo = new Date(now - 3 * 86_400_000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 86_400_000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 86_400_000).toISOString();

  // 1. Auto-archive timed-out rows first (cleanup pass).
  const { data: stale } = await supabase
    .from("email_templates")
    .select("id, rep_id")
    .eq("status", "proposal")
    .not("rep_id", "is", null)
    .not("proposed_to_rep_at", "is", null)
    .is("rep_approved_at", null)
    .lt("proposed_to_rep_at", sevenDaysAgo);
  for (const r of stale ?? []) {
    await supabase
      .from("email_templates")
      .update({
        status: "archived",
        rep_rejection_reason: "Timed out — no rep response in 7d",
      })
      .eq("id", r.id);
    per_row.push({ template_id: r.id as string, rep_id: r.rep_id as number, action: "archived" });
  }

  // 2. Fresh sends: rows we have never proposed to the rep.
  const { data: fresh } = await supabase
    .from("email_templates")
    .select("id, rep_id, name, proposed_reason, full_html_override, subject_override")
    .eq("status", "proposal")
    .not("rep_id", "is", null)
    .is("proposed_to_rep_at", null)
    .gte("created_at", fourteenDaysAgo)
    .order("created_at", { ascending: true })
    .limit(20);
  for (const row of fresh ?? []) {
    const current = await loadEffectiveTemplate(row.rep_id as number, null);
    const diff = buildDiffSummary(row as Record<string, unknown>, current as Record<string, unknown> | null);
    const messageId = await sendRepTemplateProposalCard({
      template_id: row.id as string,
      template_name: row.name as string,
      rep_id: row.rep_id as number,
      proposed_reason: (row.proposed_reason as string) ?? "(no reason)",
      diff_summary: diff,
    });
    if (messageId !== null || process.env.SMOKE_NO_CARDS === "1") {
      await supabase
        .from("email_templates")
        .update({ proposed_to_rep_at: ran_at })
        .eq("id", row.id);
      per_row.push({ template_id: row.id as string, rep_id: row.rep_id as number, action: "sent" });
    } else {
      per_row.push({
        template_id: row.id as string,
        rep_id: row.rep_id as number,
        action: "error",
        error: "send failed",
      });
    }
  }

  // 3. Re-nudges: rows already sent 72h+ ago but rep hasn't acted.
  const { data: nudgeable } = await supabase
    .from("email_templates")
    .select("id, rep_id, name, proposed_reason, full_html_override")
    .eq("status", "proposal")
    .not("rep_id", "is", null)
    .not("proposed_to_rep_at", "is", null)
    .is("rep_approved_at", null)
    .lt("proposed_to_rep_at", threeDaysAgo)
    .gte("proposed_to_rep_at", sevenDaysAgo)
    .lt("proposed_to_rep_at", dayAgo) // only re-nudge once per day
    .limit(10);
  for (const row of nudgeable ?? []) {
    const current = await loadEffectiveTemplate(row.rep_id as number, null);
    const diff = buildDiffSummary(row as Record<string, unknown>, current as Record<string, unknown> | null);
    await sendRepTemplateProposalCard({
      template_id: row.id as string,
      template_name: `${row.name as string} (再次提醒)`,
      rep_id: row.rep_id as number,
      proposed_reason: (row.proposed_reason as string) ?? "",
      diff_summary: diff,
    });
    await supabase
      .from("email_templates")
      .update({ proposed_to_rep_at: ran_at })
      .eq("id", row.id);
    per_row.push({ template_id: row.id as string, rep_id: row.rep_id as number, action: "renudged" });
  }

  return { ran_at, per_row };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await run());
}
