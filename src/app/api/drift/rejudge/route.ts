import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { judgeIntro } from "@/lib/bench-judge";

export const maxDuration = 120;

/**
 * POST /api/drift/rejudge
 * Body: { leadId: string }   — re-runs the current judge ensemble on this
 *                              lead's draft_original_html (the AI's original
 *                              output, unaffected by sales edits) so we can
 *                              detect rubric drift over time.
 *
 * Persists the verdicts back onto pipeline_leads.judge_verdicts (jsonb) and
 * judge_avg (real) and returns them.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const leadId = body.leadId as string | undefined;
  if (!leadId) {
    return NextResponse.json({ error: "leadId required" }, { status: 400 });
  }

  const { data: lead, error: fetchErr } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract, draft_original_html, draft_original_subject, draft_model")
    .eq("id", leadId)
    .single();
  if (fetchErr || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const draft = (lead.draft_original_html as string | null) ?? "";
  if (!draft) {
    return NextResponse.json({ error: "Lead has no draft_original_html to judge" }, { status: 400 });
  }

  const verdicts = await judgeIntro(
    String(lead.title ?? ""),
    String(lead.abstract ?? "").slice(0, 1500),
    String(lead.draft_model ?? "unknown"),
    stripHtml(draft).slice(0, 2000),
  );

  // Average across non-errored judges. If all errored, leave avg null.
  const valid = verdicts.filter((v) => v.error === null);
  const avg = valid.length > 0
    ? valid.reduce((s, v) => s + v.score_0_10, 0) / valid.length
    : null;
  const anyLeak = verdicts.some((v) => v.prompt_leak);

  // Persist — silently swallow errors here; the columns may not exist on
  // older deployments and that shouldn't break the response.
  await supabase
    .from("pipeline_leads")
    .update({
      judge_verdicts: verdicts,
      judge_avg: avg,
      judge_prompt_leak: anyLeak,
      judge_at: new Date().toISOString(),
    })
    .eq("id", leadId);

  return NextResponse.json({ leadId, avg, prompt_leak: anyLeak, verdicts });
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
