import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/reassign-rules
 *
 * Declarative bulk re-routing. Admin defines an ordered list of
 * rules; each rule has a "when" predicate and a "then" target rep.
 * The first matching rule wins for each lead. Unmatched leads stay
 * put.
 *
 * Two modes:
 *   - "preview" (default): returns counts per rule + 5-row sample
 *     per rule. Admin sanity-checks before applying.
 *   - "apply": runs the rules and persists. Calls /reassign-leads
 *     internally for each rule's bucket so the email cascade
 *     stays consistent.
 *
 * Predicates supported in `when`:
 *   - geo: "cn" | "edu" | "other"   (derived from author_email)
 *   - schoolTier: 1 | 2 | 3
 *   - leadTier: "strong" | "normal"
 *   - currentRepId: number | null   (null = unassigned)
 *
 * Body:
 *   {
 *     mode: "preview" | "apply",
 *     rules: [{
 *       when: { geo?, schoolTier?, leadTier?, currentRepId? },
 *       toRepId: number,
 *     }, ...]
 *   }
 *
 * Response on preview:
 *   {
 *     totalLeads: number,
 *     perRule: [{ index, toRepId, toRepName, matchCount, sample[] }],
 *     unmatched: number,
 *   }
 *
 * Response on apply:
 *   {
 *     reassigned: number,
 *     emailsCascaded: number,
 *     perRule: [{ index, toRepId, count }],
 *   }
 */

interface Predicate {
  geo?: "cn" | "edu" | "other";
  schoolTier?: number;
  leadTier?: "strong" | "normal";
  currentRepId?: number | null;
}

interface Rule {
  when: Predicate;
  toRepId: number;
}

interface LeadRow {
  id: string;
  title: string | null;
  author_email: string | null;
  author_name: string | null;
  school_tier: number | null;
  lead_tier: string | null;
  assigned_rep_id: number | null;
  thread_id: string | null;
}

function geoOf(email: string | null): "cn" | "edu" | "other" {
  const lower = (email ?? "").toLowerCase();
  if (lower.endsWith(".cn")) return "cn";
  if (lower.endsWith(".edu") || lower.endsWith(".edu.cn")) return "edu";
  return "other";
}

function matchesWhen(lead: LeadRow, when: Predicate): boolean {
  if (when.geo !== undefined && geoOf(lead.author_email) !== when.geo) return false;
  if (when.schoolTier !== undefined && lead.school_tier !== when.schoolTier) return false;
  if (when.leadTier !== undefined && lead.lead_tier !== when.leadTier) return false;
  if (when.currentRepId !== undefined) {
    if (when.currentRepId === null && lead.assigned_rep_id !== null) return false;
    if (typeof when.currentRepId === "number" && lead.assigned_rep_id !== when.currentRepId) return false;
  }
  return true;
}

function validateRule(r: unknown, idx: number): Rule | string {
  if (!r || typeof r !== "object") return `rule ${idx}: not an object`;
  const obj = r as Record<string, unknown>;
  const toRepId = Number(obj.toRepId);
  if (!Number.isFinite(toRepId)) return `rule ${idx}: toRepId required`;
  const when = (obj.when ?? {}) as Record<string, unknown>;
  const out: Predicate = {};
  if (when.geo !== undefined) {
    if (!["cn", "edu", "other"].includes(String(when.geo))) return `rule ${idx}: geo must be cn|edu|other`;
    out.geo = when.geo as "cn" | "edu" | "other";
  }
  if (when.schoolTier !== undefined) {
    const t = Number(when.schoolTier);
    if (!Number.isFinite(t)) return `rule ${idx}: schoolTier must be a number`;
    out.schoolTier = t;
  }
  if (when.leadTier !== undefined) {
    if (!["strong", "normal"].includes(String(when.leadTier))) return `rule ${idx}: leadTier must be strong|normal`;
    out.leadTier = when.leadTier as "strong" | "normal";
  }
  if (when.currentRepId !== undefined) {
    if (when.currentRepId === null) out.currentRepId = null;
    else {
      const n = Number(when.currentRepId);
      if (!Number.isFinite(n)) return `rule ${idx}: currentRepId must be a number or null`;
      out.currentRepId = n;
    }
  }
  return { when: out, toRepId };
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "apply" ? "apply" : "preview";
  if (!Array.isArray(body.rules) || body.rules.length === 0) {
    return NextResponse.json({ error: "rules[] required" }, { status: 400 });
  }
  if (body.rules.length > 20) {
    return NextResponse.json({ error: "max 20 rules per call" }, { status: 400 });
  }

  const rules: Rule[] = [];
  for (let i = 0; i < body.rules.length; i++) {
    const v = validateRule(body.rules[i], i);
    if (typeof v === "string") return NextResponse.json({ error: v }, { status: 400 });
    rules.push(v);
  }

  // Verify every target rep exists and is active.
  const targetIds = Array.from(new Set(rules.map((r) => r.toRepId)));
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, active")
    .in("id", targetIds);
  const repMap = new Map((reps ?? []).map((r) => [r.id as number, r]));
  for (const r of rules) {
    const rep = repMap.get(r.toRepId);
    if (!rep) return NextResponse.json({ error: `target rep ${r.toRepId} not found` }, { status: 400 });
    if (rep.active === false) return NextResponse.json({ error: `rep ${rep.name} is inactive` }, { status: 400 });
  }

  // Pull all leads. Cap at 5000 — anything bigger than that and we
  // need to switch to a streaming or chunked approach.
  const { data: leads, error: leadsErr } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_email, author_name, school_tier, lead_tier, assigned_rep_id, thread_id")
    .limit(5000);
  if (leadsErr) return NextResponse.json({ error: leadsErr.message }, { status: 500 });

  // Bucket leads by first matching rule.
  const buckets: { rule: Rule; ruleIdx: number; leads: LeadRow[] }[] = rules.map((r, i) => ({ rule: r, ruleIdx: i, leads: [] }));
  let unmatched = 0;
  for (const l of (leads ?? []) as LeadRow[]) {
    let matched = false;
    for (let i = 0; i < rules.length; i++) {
      if (matchesWhen(l, rules[i].when)) {
        // Skip no-ops: already assigned to the rule's target.
        if (l.assigned_rep_id !== rules[i].toRepId) {
          buckets[i].leads.push(l);
        }
        matched = true;
        break;
      }
    }
    if (!matched) unmatched++;
  }

  if (mode === "preview") {
    return NextResponse.json({
      totalLeads: leads?.length ?? 0,
      unmatched,
      perRule: buckets.map((b) => ({
        index: b.ruleIdx,
        toRepId: b.rule.toRepId,
        toRepName: repMap.get(b.rule.toRepId)?.name ?? `rep ${b.rule.toRepId}`,
        when: b.rule.when,
        matchCount: b.leads.length,
        sample: b.leads.slice(0, 5).map((l) => ({
          id: l.id,
          title: l.title,
          author_name: l.author_name,
          fromRepId: l.assigned_rep_id,
          leadTier: l.lead_tier,
        })),
      })),
    });
  }

  // mode === "apply": run each bucket through the same path the
  // single-rep-change uses, with the email cascade.
  let totalReassigned = 0;
  let totalCascaded = 0;
  const perRuleResults: { index: number; toRepId: number; count: number }[] = [];
  for (const b of buckets) {
    if (b.leads.length === 0) {
      perRuleResults.push({ index: b.ruleIdx, toRepId: b.rule.toRepId, count: 0 });
      continue;
    }
    const ids = b.leads.map((l) => l.id);
    const threadIds = b.leads.map((l) => l.thread_id).filter((t): t is string => !!t);

    const { error: lErr, count: lCount } = await supabase
      .from("pipeline_leads")
      .update({ assigned_rep_id: b.rule.toRepId }, { count: "exact" })
      .in("id", ids);
    if (lErr) {
      console.warn("rule apply lead update failed", { idx: b.ruleIdx, err: lErr.message });
      continue;
    }
    totalReassigned += lCount ?? 0;
    perRuleResults.push({ index: b.ruleIdx, toRepId: b.rule.toRepId, count: lCount ?? 0 });

    // Email cascade in chunks of 150.
    const CHUNK = 150;
    for (let i = 0; i < threadIds.length; i += CHUNK) {
      const chunk = threadIds.slice(i, i + CHUNK);
      const { error: eErr, count: eCount } = await supabase
        .from("emails")
        .update({ rep_id: b.rule.toRepId }, { count: "exact" })
        .in("thread_id", chunk);
      if (eErr) {
        console.warn("rule apply email cascade chunk failed", { idx: b.ruleIdx, i, err: eErr.message });
        continue;
      }
      totalCascaded += eCount ?? 0;
    }
  }

  return NextResponse.json({
    reassigned: totalReassigned,
    emailsCascaded: totalCascaded,
    perRule: perRuleResults,
    unmatched,
  });
}
