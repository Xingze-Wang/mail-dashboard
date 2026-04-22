import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { getAssignmentConfig, classifyLead, assignRep, getRep } from "@/lib/assignment";

export const dynamic = "force-dynamic";

/**
 * GET /api/scorer/match
 *
 * "Is this the right rep for this lead?" — encodes the rules in assignment.ts
 * as an explicit per-lead score with reasons, so admins can audit assignments
 * and sales can see why a lead landed on their desk.
 *
 * Also returns per-rep historical conversion stats so admin can spot
 * mismatches (e.g. "Leo gets all the strongs but converts half as much").
 *
 * GET /api/scorer/match?leadId=xxx
 *   → Returns rule-by-rule breakdown for that one lead.
 * GET /api/scorer/match
 *   → Returns aggregate: per-rep conversion rate + sample-size + routing-
 *     rule distribution across all sent leads.
 */

interface LeadRow {
  id: string;
  title: string | null;
  author_email: string | null;
  citation_count: number | null;
  h_index: number | null;
  school_tier: number | null;
  local_score: number | null;
  lead_tier: string | null;
  assigned_rep_id: number | null;
  matched_directions: string | null;
  status: string;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const leadId = url.searchParams.get("leadId");

  const config = await getAssignmentConfig();

  // ── Per-lead mode ─────────────────────────────────────────────
  if (leadId) {
    const { data: lead, error } = await supabase
      .from("pipeline_leads")
      .select("*")
      .eq("id", leadId)
      .single();
    if (error || !lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

    const matchedDirs = parseMatchedDirections(lead.matched_directions);
    const recomputedTier = classifyLead(config, {
      citationCount: lead.citation_count,
      hIndex: lead.h_index,
      schoolTier: lead.school_tier,
      authorEmail: lead.author_email,
      localScore: lead.local_score,
    });
    const recomputedRepId = assignRep(config, recomputedTier, lead.author_email, matchedDirs);
    const currentRep = lead.assigned_rep_id ? await getRep(lead.assigned_rep_id) : null;
    const recomputedRep = await getRep(recomputedRepId);

    const reasons: string[] = [];
    if (recomputedTier === "strong") {
      reasons.push(`Strong tier → goes to ${recomputedRep?.sender_name ?? "strong rep"}`);
      if ((lead.school_tier ?? 99) <= config.strong_criteria.max_school_tier) {
        reasons.push(`  school_tier=${lead.school_tier} (≤ ${config.strong_criteria.max_school_tier})`);
      }
      if ((lead.citation_count ?? 0) > config.strong_criteria.min_citation) {
        reasons.push(`  citations=${lead.citation_count} (> ${config.strong_criteria.min_citation})`);
      }
      if ((lead.local_score ?? 0) >= config.strong_criteria.min_local_score) {
        reasons.push(`  local_score=${lead.local_score?.toFixed(2)} (≥ ${config.strong_criteria.min_local_score})`);
      }
    } else {
      const byDir = config.assignment.by_direction ?? {};
      const dirMatch = matchedDirs.find((d) => byDir[d] !== undefined);
      if (dirMatch) {
        reasons.push(`Normal, direction "${dirMatch}" → routed to ${recomputedRep?.sender_name}`);
      } else if ((lead.author_email ?? "").endsWith(".cn")) {
        reasons.push(`Normal domestic (.cn) → routed to ${recomputedRep?.sender_name}`);
      } else {
        reasons.push(`Normal overseas → routed to ${recomputedRep?.sender_name}`);
      }
    }

    // Confidence: strong tier with multiple signals meeting threshold = 1.0;
    // just scraping by on one = 0.5-0.8.
    const confidence = computeConfidence(lead, config, recomputedTier);

    return NextResponse.json({
      leadId,
      currentRepId: lead.assigned_rep_id,
      currentRepName: currentRep?.sender_name ?? null,
      recomputedRepId,
      recomputedRepName: recomputedRep?.sender_name ?? null,
      routingMatches: lead.assigned_rep_id === recomputedRepId,
      tier: recomputedTier,
      confidence,
      reasons,
    });
  }

  // ── Aggregate mode ────────────────────────────────────────────
  // Per-rep stats pull from the `emails` table (the real send log — ~1100
  // rows) so historical sends that never went through pipeline_leads still
  // count. Routing-rule / misrouted stats still come from pipeline_leads
  // because only new leads carry assigned_rep_id.
  const { data: leadsRaw, error } = await supabase
    .from("pipeline_leads")
    .select(
      "id, title, author_email, citation_count, h_index, school_tier, local_score, lead_tier, assigned_rep_id, matched_directions, status",
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const leads = (leadsRaw ?? []) as LeadRow[];
  const sent = leads.filter((l) =>
    l.status === "sent" || l.status === "replied" || l.status === "wechat_added",
  );

  const { data: wechatRaw } = await supabase
    .from("brief_lookups")
    .select("query")
    .eq("added_wechat", true);
  const wechatEmails = new Set(
    (wechatRaw ?? [])
      .map((w) => (w.query as string | null)?.toLowerCase().trim())
      .filter(Boolean) as string[],
  );

  // Page through all delivered-or-clicked emails to get the real send log.
  const allEmails: { from: string | null; to: string | null; status: string | null }[] = [];
  let cursor = 0;
  const pageSize = 1000;
  while (true) {
    const { data: page } = await supabase
      .from("emails")
      .select("from, to, status")
      .in("status", ["delivered", "clicked", "sent", "replied"])
      .range(cursor, cursor + pageSize - 1);
    if (!page || page.length === 0) break;
    allEmails.push(...page);
    if (page.length < pageSize) break;
    cursor += pageSize;
    if (cursor > 20_000) break;
  }

  const { data: repsRaw } = await supabase.from("sales_reps").select("id, sender_name, sender_email").eq("active", true);
  const repsByEmail = new Map<string, { id: number; name: string }>();
  const repsById = new Map<number, { id: number; name: string; email: string }>();
  for (const r of repsRaw ?? []) {
    const id = r.id as number;
    const email = String(r.sender_email ?? "").toLowerCase().trim();
    const name = String(r.sender_name ?? `rep ${id}`);
    if (email) repsByEmail.set(email, { id, name });
    repsById.set(id, { id, name, email });
  }

  // Feature lookup for mean-lead-score by email
  const leadFeaturesByEmail = new Map<string, { localScore: number | null; tier: string | null }>();
  for (const l of leads) {
    const em = (l.author_email ?? "").toLowerCase().trim();
    if (em) leadFeaturesByEmail.set(em, { localScore: l.local_score, tier: l.lead_tier });
  }

  // Dedupe sends by (rep, recipient) — a rep sending the same person twice
  // shouldn't inflate their "sent" count; we care about unique contacts.
  const repContacts = new Map<number, { recipients: Set<string>; converted: number; scoreSum: number; scoreN: number }>();
  for (const e of allEmails) {
    const fromAddr = extractEmailAddr(e.from);
    const toAddr = (e.to ?? "").toLowerCase().trim();
    if (!fromAddr || !toAddr) continue;
    const rep = repsByEmail.get(fromAddr);
    if (!rep) continue;
    const bucket = repContacts.get(rep.id) ?? { recipients: new Set<string>(), converted: 0, scoreSum: 0, scoreN: 0 };
    if (!bucket.recipients.has(toAddr)) {
      bucket.recipients.add(toAddr);
      if (wechatEmails.has(toAddr)) bucket.converted++;
      const feat = leadFeaturesByEmail.get(toAddr);
      if (feat && typeof feat.localScore === "number") {
        bucket.scoreSum += feat.localScore;
        bucket.scoreN++;
      }
    }
    repContacts.set(rep.id, bucket);
  }

  const byRep = Array.from(repContacts.entries()).map(([repId, v]) => ({
    repId,
    repName: repsById.get(repId)?.name ?? `rep ${repId}`,
    sent: v.recipients.size,
    converted: v.converted,
    convRate: v.recipients.size > 0 ? Math.round((v.converted / v.recipients.size) * 1000) / 10 : 0,
    meanLeadScore: v.scoreN > 0 ? Math.round((v.scoreSum / v.scoreN) * 100) / 100 : 0,
  }));
  byRep.sort((a, b) => b.sent - a.sent);

  // Routing rule distribution across all sent leads (which rule sent them there)
  const ruleCounts: Record<string, number> = {
    strong: 0,
    by_direction: 0,
    overseas: 0,
    domestic: 0,
  };
  for (const l of sent) {
    if (l.lead_tier === "strong") {
      ruleCounts.strong++;
      continue;
    }
    const byDir = config.assignment.by_direction ?? {};
    const dirs = parseMatchedDirections(l.matched_directions);
    if (dirs.some((d) => byDir[d] !== undefined)) {
      ruleCounts.by_direction++;
    } else if ((l.author_email ?? "").endsWith(".cn")) {
      ruleCounts.domestic++;
    } else {
      ruleCounts.overseas++;
    }
  }

  // Mis-routed count: leads whose current assigned_rep_id ≠ what the rules
  // would recompute today (happens after config changes — good audit signal).
  let misrouted = 0;
  for (const l of sent) {
    if (l.assigned_rep_id === null) continue;
    const matchedDirs = parseMatchedDirections(l.matched_directions);
    const tier = classifyLead(config, {
      citationCount: l.citation_count,
      hIndex: l.h_index,
      schoolTier: l.school_tier,
      authorEmail: l.author_email ?? undefined,
      localScore: l.local_score,
    });
    const recomputedRep = assignRep(config, tier, l.author_email, matchedDirs);
    if (l.assigned_rep_id !== recomputedRep) misrouted++;
  }

  return NextResponse.json({
    totalSent: sent.length,
    byRep,
    ruleCounts,
    misrouted,
    strongCriteria: config.strong_criteria,
  });
}

/** Pulls the bare email address out of a "Name <addr@x>" string. */
function extractEmailAddr(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).toLowerCase().trim();
  return addr.includes("@") ? addr : null;
}

function parseMatchedDirections(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // not JSON
  }
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function computeConfidence(lead: LeadRow, config: Awaited<ReturnType<typeof getAssignmentConfig>>, tier: string): number {
  if (tier === "strong") {
    let hits = 0;
    if ((lead.school_tier ?? 99) <= config.strong_criteria.max_school_tier) hits++;
    if ((lead.citation_count ?? 0) > config.strong_criteria.min_citation) hits++;
    if ((lead.local_score ?? 0) >= config.strong_criteria.min_local_score) hits++;
    return Math.min(1, 0.4 + hits * 0.25);
  }
  // Normal: direction override = high, email-country = medium
  const byDir = config.assignment.by_direction ?? {};
  const dirs = parseMatchedDirections(lead.matched_directions);
  if (dirs.some((d) => byDir[d] !== undefined)) return 0.85;
  return 0.7;
}
