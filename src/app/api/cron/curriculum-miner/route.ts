// Curriculum miner — runs daily, clusters rep_questions by normalized
// text, and surfaces clusters that ≥2 distinct reps have asked but
// canonical_onboarding_topics doesn't yet cover.
//
// Each surfaced cluster → admin_inbox card (kind=idea) with the
// Skill/Memory/Both/Neither buttons. Admin picks Skill or Both →
// helper_learnings row + (TODO) auto-promotion into canonical
// onboarding topics. Today this lands as an idea; the canonical
// promotion path is the v2.
//
// Clustering algo: trigram similarity on the normalized text. We use
// pg_trgm's `similarity()` function which is already indexed by 087.
// For every question in the window:
//   - find others where similarity(a.normalized, b.normalized) > 0.55
//   - if distinct rep count ≥ MIN_REPS → it's a cluster
//   - dedup: if any helper_learning body already covers this cluster
//     (trigram match >0.55 against the medoid), skip
//
// This is intentionally simple. Future: LLM-based intent grouping,
// embedding-space clustering, etc.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const preferredRegion = ["hkg1"];
export const maxDuration = 60;

const LOOKBACK_DAYS = 30;
const MIN_DISTINCT_REPS = 2;
// trigram similarity is character-codepoint based, which hurts on Chinese
// (cross-question similarity for paraphrases lands in 0.25-0.35 range
// even when topically identical). We pick a low threshold and rely on
// the admin's Skill/Memory/Both/Neither click to filter false positives.
const SIMILARITY_THRESHOLD = 0.25;

interface MinerResult {
  ran_at: string;
  dry: boolean;
  questions_pulled: number;
  clusters_found: number;
  clusters_promoted_to_inbox: number;
  clusters_skipped_dup: number;
  details: Array<{
    medoid_normalized: string;
    distinct_reps: number[];
    total_questions: number;
    inbox_id?: string;
    skipped_reason?: string;
  }>;
}

function authorizeCron(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return false;
  return auth === `Bearer ${secret}`;
}

async function run(dry: boolean): Promise<MinerResult> {
  const result: MinerResult = {
    ran_at: new Date().toISOString(),
    dry,
    questions_pulled: 0,
    clusters_found: 0,
    clusters_promoted_to_inbox: 0,
    clusters_skipped_dup: 0,
    details: [],
  };

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: questions, error } = await supabase
    .from("rep_questions")
    .select("id, rep_id, raw_text, normalized, outcome, asked_at")
    .gte("asked_at", since)
    .not("rep_id", "is", null)
    .not("normalized", "is", null);
  if (error) throw new Error(`rep_questions query failed: ${error.message}`);

  const rows = questions ?? [];
  result.questions_pulled = rows.length;
  if (rows.length < MIN_DISTINCT_REPS) return result;

  // Greedy clustering: walk rows, group via pg_trgm similarity. Cheap
  // for ≤a few hundred questions; if this grows we'll switch to an
  // embedding-based approach.
  const used = new Set<string>();
  const clusters: Array<{ medoid: string; members: typeof rows; distinctReps: Set<number> }> = [];

  for (const seed of rows) {
    if (used.has(seed.id)) continue;
    if (!seed.normalized || seed.normalized.length < 8) continue;

    // Find similar rows via SQL (trigram). Cheap because of the GIN index.
    const { data: similar } = await supabase.rpc("rep_questions_similar", {
      target_text: seed.normalized,
      threshold: SIMILARITY_THRESHOLD,
      since_iso: since,
    });

    // RPC may not exist yet in early deploys — fall back to in-memory
    // trigram approximation on the seed batch.
    let members: typeof rows;
    if (similar && Array.isArray(similar)) {
      const idSet = new Set(similar.map((s: { id: string }) => s.id));
      members = rows.filter((r) => idSet.has(r.id));
    } else {
      // In-memory fallback: token-overlap (poor man's trigram). Adequate
      // for small batches; the cron runs nightly so any drift is fine.
      const seedTokens = new Set(seed.normalized.split(/\s+/).filter((t: string) => t.length >= 3));
      members = rows.filter((r) => {
        if (used.has(r.id)) return false;
        if (!r.normalized) return false;
        const rTokens = new Set(r.normalized.split(/\s+/).filter((t: string) => t.length >= 3));
        let overlap = 0;
        for (const t of seedTokens) if (rTokens.has(t)) overlap++;
        const denom = Math.max(seedTokens.size, rTokens.size);
        return denom > 0 && overlap / denom >= SIMILARITY_THRESHOLD;
      });
    }

    if (members.length < MIN_DISTINCT_REPS) {
      used.add(seed.id);
      continue;
    }
    const distinctReps = new Set(members.map((m) => m.rep_id!).filter((r) => r != null));
    if (distinctReps.size < MIN_DISTINCT_REPS) {
      // Same rep asking 10× is "rep stuck", not "structural gap" —
      // already handled by the escalation flow. Skip.
      for (const m of members) used.add(m.id);
      continue;
    }
    for (const m of members) used.add(m.id);
    clusters.push({ medoid: seed.normalized, members, distinctReps });
  }

  result.clusters_found = clusters.length;

  // Dedup against existing helper_learnings: pull all active learning bodies
  const { data: learnings } = await supabase
    .from("helper_learnings")
    .select("id, body, kind")
    .is("superseded_at", null);
  const learningBodies = (learnings ?? []).map((l) => l.body.toLowerCase());

  // Dedup against canonical_onboarding_topics
  const { data: topics } = await supabase
    .from("canonical_onboarding_topics")
    .select("question")
    .eq("active", true);
  const topicQuestions = (topics ?? []).map((t) => t.question.toLowerCase());

  function overlapsExisting(medoid: string): boolean {
    const med = medoid.toLowerCase();
    const medTokens = new Set(med.split(/\s+/).filter((t: string) => t.length >= 3));
    for (const body of [...learningBodies, ...topicQuestions]) {
      const bTokens = new Set(body.split(/\s+/).filter((t: string) => t.length >= 3));
      let overlap = 0;
      for (const t of medTokens) if (bTokens.has(t)) overlap++;
      const denom = Math.max(medTokens.size, bTokens.size);
      if (denom > 0 && overlap / denom >= 0.5) return true;
    }
    return false;
  }

  for (const c of clusters) {
    const detail = {
      medoid_normalized: c.medoid,
      distinct_reps: Array.from(c.distinctReps),
      total_questions: c.members.length,
      inbox_id: undefined as string | undefined,
      skipped_reason: undefined as string | undefined,
    };
    if (overlapsExisting(c.medoid)) {
      detail.skipped_reason = "already covered by an active learning or canonical topic";
      result.clusters_skipped_dup++;
      result.details.push(detail);
      continue;
    }
    if (dry) {
      detail.skipped_reason = "dry run";
      result.details.push(detail);
      continue;
    }
    // Promote: push admin_inbox card kind=idea
    const sample = c.members.slice(0, 3).map((m) => `- "${m.raw_text.slice(0, 120)}" — rep_id=${m.rep_id}`).join("\n");
    const headline = `${c.distinctReps.size} 个 rep 都问过: ${c.medoid.slice(0, 140)}`.slice(0, 200);
    const body = `${c.distinctReps.size} 个不同 rep 在过去 ${LOOKBACK_DAYS} 天里问过类似问题 (${c.members.length} 次). 像是 onboarding 时该 front-load 的内容. \n\n样本:\n${sample}\n\n如果觉得值得入 onboarding 流程, 点 [Skill] 或 [Both]; 只想存 memory 给 Leon 答, 点 [Memory].`;

    // dedup hash so we don't spam admin daily for the same cluster
    const enc = new TextEncoder();
    const key = `curriculum|${c.medoid.toLowerCase().slice(0, 100)}`;
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
    const dedupHash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const { data: existing } = await supabase
      .from("admin_inbox")
      .select("id, status")
      .eq("dedup_hash", dedupHash)
      .maybeSingle();
    if (existing && (existing.status === "new" || existing.status === "acknowledged")) {
      detail.inbox_id = existing.id;
      detail.skipped_reason = "already in admin inbox (pending)";
      result.details.push(detail);
      continue;
    }
    if (existing && (existing.status === "dismissed" || existing.status === "done")) {
      // Admin already decided on this cluster — respect it
      detail.skipped_reason = `previously ${existing.status}`;
      result.details.push(detail);
      continue;
    }

    const { data: inserted, error: insErr } = await supabase
      .from("admin_inbox")
      .insert({
        kind: "idea",
        headline,
        body,
        source_rep_id: null,
        evidence: {
          source: "curriculum_miner",
          medoid: c.medoid,
          distinct_reps: Array.from(c.distinctReps),
          question_ids: c.members.map((m) => m.id),
          sample_questions: c.members.slice(0, 5).map((m) => ({ rep_id: m.rep_id, text: m.raw_text.slice(0, 200) })),
        },
        dedup_hash: dedupHash,
      })
      .select("id")
      .single();
    if (insErr) {
      detail.skipped_reason = `insert failed: ${insErr.message}`;
      result.details.push(detail);
      continue;
    }
    detail.inbox_id = inserted.id;
    result.clusters_promoted_to_inbox++;
    result.details.push(detail);

    // Push Lark card (Skill/Memory/Both/Neither buttons since kind=idea)
    try {
      const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
      await sendAdminInboxCard({
        inbox_id: inserted.id,
        kind: "idea",
        headline,
        body,
        source_rep_id: null,
        source_rep_name: null,
      });
    } catch (err) {
      console.warn("[curriculum-miner] card push failed (non-blocking):", err);
    }
  }

  return result;
}

export async function GET(req: NextRequest) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  try {
    const r = await run(dry);
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Admin-triggered manual run from /admin/curriculum
  const { requireSession } = await import("@/lib/auth-helpers");
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { dry?: boolean };
  const r = await run(body.dry !== false);  // POST defaults to dry for safety
  return NextResponse.json(r);
}
