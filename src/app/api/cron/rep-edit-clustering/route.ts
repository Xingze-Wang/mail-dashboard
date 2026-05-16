import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { embedText } from "@/lib/embeddings";
import { clusterEdits, pickMedoid, clusterTightness, type EditItem } from "@/lib/edit-clustering";
import { requireSession } from "@/lib/auth-helpers";

export const preferredRegion = ["hkg1"];
export const maxDuration = 300;

const COSINE_THRESHOLD = 0.85;
const MIN_CLUSTER_SIZE = 5;
const MIN_EDIT_DISTANCE = 50;
const LOOKBACK_DAYS = 30;

interface RunResult {
  ran_at: string;
  dry: boolean;
  per_rep: Array<{
    rep_id: number;
    rep_name: string;
    edits_pulled: number;
    clusters_found: number;
    clusters_qualifying: number;
    template_action?: "created" | "replaced" | "no_change" | "manual_template_in_place";
    new_template_id?: string;
    skipped_reason?: string;
  }>;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function run(dry: boolean): Promise<RunResult> {
  const result: RunResult = { ran_at: new Date().toISOString(), dry, per_rep: [] };
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const reps = await supabase
    .from("sales_reps")
    .select("id, name")
    .eq("active", true)
    .eq("role", "sales");
  if (reps.error || !reps.data) {
    throw new Error(`reps query failed: ${reps.error?.message ?? "no data"}`);
  }

  for (const rep of reps.data) {
    const entry: RunResult["per_rep"][number] = {
      rep_id: rep.id as number,
      rep_name: rep.name as string,
      edits_pulled: 0,
      clusters_found: 0,
      clusters_qualifying: 0,
    };

    const edits = await supabase
      .from("pipeline_leads")
      .select("id, draft_original_html, draft_html, draft_original_subject, draft_subject, draft_edit_distance, sent_at")
      .eq("assigned_rep_id", rep.id)
      .eq("status", "sent")
      .gte("sent_at", since)
      .not("draft_original_html", "is", null)
      .not("draft_html", "is", null)
      .gt("draft_edit_distance", MIN_EDIT_DISTANCE)
      .limit(200);
    if (edits.error || !edits.data || edits.data.length < MIN_CLUSTER_SIZE) {
      entry.skipped_reason = `only ${edits.data?.length ?? 0} qualifying edits (need ${MIN_CLUSTER_SIZE})`;
      result.per_rep.push(entry);
      continue;
    }
    entry.edits_pulled = edits.data.length;

    const items: EditItem[] = [];
    for (const e of edits.data) {
      const text = stripHtml((e.draft_html as string) ?? "").slice(0, 2000);
      if (text.length < 50) continue;
      try {
        const vec = await embedText(text);
        items.push({ id: e.id as string, vec });
      } catch (err) {
        console.error(`[rep-edit-clustering] embedding failed for lead ${e.id}:`, err);
      }
    }

    const clusters = clusterEdits(items, COSINE_THRESHOLD);
    entry.clusters_found = clusters.length;

    const qualifying = clusters.filter((c) => c.members.length >= MIN_CLUSTER_SIZE);
    entry.clusters_qualifying = qualifying.length;
    if (qualifying.length === 0) {
      entry.skipped_reason = "no cluster reached min size";
      result.per_rep.push(entry);
      continue;
    }

    qualifying.sort((a, b) => b.members.length - a.members.length);
    const winner = qualifying[0];
    const medoid = pickMedoid(winner.members, winner.centroid);
    const medoidLead = edits.data.find((e) => e.id === medoid.id);
    if (!medoidLead) {
      entry.skipped_reason = "medoid lead not found in fetched edits";
      result.per_rep.push(entry);
      continue;
    }

    const existing = await supabase
      .from("email_templates")
      .select("id, proposed_by, full_html_override, name")
      .eq("rep_id", rep.id)
      .eq("active", true)
      .maybeSingle();

    if (existing.data && existing.data.proposed_by !== "rep_edit_cluster") {
      entry.template_action = "manual_template_in_place";
      result.per_rep.push(entry);
      continue;
    }

    const newHtml = (medoidLead.draft_html as string) ?? "";
    const newSubject = (medoidLead.draft_subject as string) ?? null;

    if (existing.data && existing.data.full_html_override === newHtml) {
      entry.template_action = "no_change";
      result.per_rep.push(entry);
      continue;
    }

    const sampleIds = winner.members.slice(0, 10).map((m) => m.id);
    const evidence = {
      cluster_size: winner.members.length,
      sample_lead_ids: sampleIds,
      centroid_tightness: clusterTightness(winner.members),
      medoid_lead_id: medoid.id,
      detection_run_at: result.ran_at,
      dedup_key: `rep-edit-cluster-${rep.id}-${medoid.id}`,
    };

    if (dry) {
      entry.template_action = existing.data ? "replaced" : "created";
      result.per_rep.push(entry);
      continue;
    }

    // IMPORTANT: do NOT touch the existing active template here. The
    // previous behavior was to deactivate + replace atomically, which
    // skipped admin approval entirely (any LLM clustering would silently
    // swap a rep's voice). New flow: insert a PROPOSAL (active:false,
    // status:'proposal') and notify admin via the Lark approval card.
    // Existing active template stays live until admin clicks Activate
    // on the card, at which point the card handler runs the
    // deactivate-competitors-then-activate step (admin-approval-cards.ts).
    const proposalName = `${rep.name}'s edit pattern (${winner.members.length} edits)`;

    const ins = await supabase
      .from("email_templates")
      .insert({
        name: proposalName,
        rep_id: rep.id,
        active: false,
        status: "proposal",
        proposed_by: "rep_edit_cluster",
        proposed_reason: `Auto-detected from ${winner.members.length} similar edits by ${rep.name} in the last ${LOOKBACK_DAYS} days. Tightness ${evidence.centroid_tightness.toFixed(3)}.`,
        proposed_evidence: evidence,
        full_html_override: newHtml,
        subject_override: newSubject,
      })
      .select("id")
      .maybeSingle();
    if (ins.error) {
      entry.skipped_reason = `insert failed: ${ins.error.message}`;
    } else {
      entry.template_action = existing.data ? "replaced" : "created";
      entry.new_template_id = ins.data?.id as string;
      // Old behavior fired sendTemplateProposalCard here directly. That's now
      // wrong: the new flow goes rep-side first. The
      // /api/cron/propose-templates-to-reps cron picks up
      // status='proposal' AND rep_id IS NOT NULL within 24h and DMs the rep.
      // Admin card fires AFTER rep ✓ (see Task 6 in
      // docs/superpowers/plans/2026-05-16-auto-template-propose-to-rep.md).
    }
    result.per_rep.push(entry);
  }

  return result;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const result = await run(dry);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const dry = body.dry === true;
  const result = await run(dry);
  return NextResponse.json(result);
}
