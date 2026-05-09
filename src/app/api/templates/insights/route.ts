import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 60;

/**
 * GET /api/templates/insights?days=30
 *
 * Cross-cuts email_ratings × emails × email_templates to surface
 * human-vs-AI agreement gaps. Output is one row per template:
 *   - n_emails_rated_by_human / mean(human_score)
 *   - n_emails_rated_by_ai / mean(ai_score)
 *   - n_emails_rated_by_both / mean(|ai - human|)  ← agreement gap
 *   - sample reasonings (one human + one AI) for the templates
 *
 * The agreement gap is the user's "human/ai comparison data" framing.
 * If AI rates intro_v2 = 4.2 but humans give it 2.8, that disagreement
 * is itself a hypothesis-generating signal: AI may be over-weighting
 * a feature humans don't trust, or vice versa.
 *
 * Auth: admin only.
 */
async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(180, Number(url.searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Pull recent emails with their template_id + ratings. One round trip
  // each, then join in memory — postgres doesn't have a clean way to
  // do "for each template, list its ratings" via supabase-js without
  // a view, and the volumes are small enough (hundreds of emails per
  // window) that JS aggregation is fine.
  const { data: emails } = await supabase
    .from("emails")
    .select("id, template_id, intro_output")
    .gte("created_at", since)
    .not("template_id", "is", null);
  const emailIds = (emails ?? []).map((e) => e.id as string);

  const { data: ratings } = emailIds.length > 0
    ? await supabase
        .from("email_ratings")
        .select("email_id, rater_kind, score, reasoning")
        .in("email_id", emailIds)
    : { data: [] as { email_id: string; rater_kind: string; score: number; reasoning: string | null }[] };

  // Per email: collect human + ai score
  type EmailScores = { tplId: string; human?: number; ai?: number; humanReason?: string; aiReason?: string };
  const byEmail = new Map<string, EmailScores>();
  for (const e of emails ?? []) {
    byEmail.set(e.id as string, { tplId: e.template_id as string });
  }
  for (const r of ratings ?? []) {
    const slot = byEmail.get(r.email_id as string);
    if (!slot) continue;
    if (r.rater_kind === "human") {
      slot.human = r.score;
      if (r.reasoning && !slot.humanReason) slot.humanReason = r.reasoning;
    } else if (r.rater_kind === "ai") {
      slot.ai = r.score;
      if (r.reasoning && !slot.aiReason) slot.aiReason = r.reasoning;
    }
  }

  // Aggregate per template
  type TplAgg = {
    tplId: string;
    nHuman: number;
    sumHuman: number;
    nAi: number;
    sumAi: number;
    nBoth: number;
    sumGap: number;
    sampleHumanReason?: string;
    sampleAiReason?: string;
  };
  const byTpl = new Map<string, TplAgg>();
  for (const slot of byEmail.values()) {
    const a = byTpl.get(slot.tplId) ?? {
      tplId: slot.tplId,
      nHuman: 0,
      sumHuman: 0,
      nAi: 0,
      sumAi: 0,
      nBoth: 0,
      sumGap: 0,
    };
    if (slot.human != null) {
      a.nHuman++;
      a.sumHuman += slot.human;
      if (!a.sampleHumanReason && slot.humanReason) a.sampleHumanReason = slot.humanReason;
    }
    if (slot.ai != null) {
      a.nAi++;
      a.sumAi += slot.ai;
      if (!a.sampleAiReason && slot.aiReason) a.sampleAiReason = slot.aiReason;
    }
    if (slot.human != null && slot.ai != null) {
      a.nBoth++;
      a.sumGap += Math.abs(slot.ai - slot.human);
    }
    byTpl.set(slot.tplId, a);
  }

  // Names for each template
  const tplIds = [...byTpl.keys()];
  const { data: tpls } = tplIds.length > 0
    ? await supabase.from("email_templates").select("id, name, status, segment_default").in("id", tplIds)
    : { data: [] as { id: string; name: string; status: string; segment_default: string | null }[] };
  const nameById = new Map((tpls ?? []).map((t) => [t.id as string, t]));

  const rows = [...byTpl.values()].map((a) => {
    const t = nameById.get(a.tplId);
    return {
      template_id: a.tplId,
      template_name: t?.name ?? null,
      template_status: t?.status ?? null,
      template_segment: t?.segment_default ?? null,
      n_human: a.nHuman,
      mean_human: a.nHuman > 0 ? a.sumHuman / a.nHuman : null,
      n_ai: a.nAi,
      mean_ai: a.nAi > 0 ? a.sumAi / a.nAi : null,
      n_both: a.nBoth,
      mean_gap: a.nBoth > 0 ? a.sumGap / a.nBoth : null,
      sample_human_reason: a.sampleHumanReason ?? null,
      sample_ai_reason: a.sampleAiReason ?? null,
    };
  });

  // Sort by gap descending (biggest disagreements at top — those are
  // the hypothesis-generating ones).
  rows.sort((a, b) => (b.mean_gap ?? -1) - (a.mean_gap ?? -1));

  return NextResponse.json({ windowDays: days, rows });
}
