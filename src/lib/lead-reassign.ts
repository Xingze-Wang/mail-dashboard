// src/lib/lead-reassign.ts
//
// Extracted from src/app/api/help/execute/route.ts so both the web
// execute path AND the Lark admin_inbox Yes-button path can call the
// same logic. Without this, Lark proposals (reassign_lead /
// reassign_leads_bulk) wrapped in record_admin_request would push an
// admin Yes/No card, admin clicks Yes, inbox marks acknowledged, and
// nothing actually moves — silent no-op gap. See admin-inbox-card.ts
// side-effect block keyed on evidence.proposal_action.
//
// Asymmetry preserved: assigned_rep_id (owner) is mutable, actor_rep_id
// on emails is NOT. emails.rep_id (which is owner-aligned) cascades when
// thread_id is known.

import { supabase } from "@/lib/db";

export async function doReassignLead(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  if (session.role !== "admin") {
    return { ok: false, detail: { error: "admin only" } };
  }
  const leadId = typeof params.lead_id === "string" ? params.lead_id : "";
  const toRepId = Number(params.to_rep_id);
  if (!leadId || !Number.isFinite(toRepId)) {
    return { ok: false, detail: { error: "lead_id and to_rep_id required" } };
  }

  // Confirm the lead + target rep both exist before any writes.
  const [leadRes, repRes] = await Promise.all([
    supabase.from("pipeline_leads").select("id, thread_id, assigned_rep_id").eq("id", leadId).maybeSingle(),
    supabase.from("sales_reps").select("id, name, active").eq("id", toRepId).maybeSingle(),
  ]);
  if (!leadRes.data) return { ok: false, detail: { error: "lead not found" } };
  if (!repRes.data) return { ok: false, detail: { error: "target rep not found" } };
  if (repRes.data.active === false) {
    return { ok: false, detail: { error: `rep ${repRes.data.name} is inactive` } };
  }
  if (leadRes.data.assigned_rep_id === toRepId) {
    return { ok: true, detail: { reassigned: 0, note: `already assigned to ${repRes.data.name}` } };
  }

  const { error: leadErr } = await supabase
    .from("pipeline_leads")
    .update({ assigned_rep_id: toRepId })
    .eq("id", leadId);
  if (leadErr) return { ok: false, detail: { error: leadErr.message } };

  let cascaded = 0;
  if (leadRes.data.thread_id) {
    const { error: emailErr, count } = await supabase
      .from("emails")
      .update({ rep_id: toRepId }, { count: "exact" })
      .eq("thread_id", leadRes.data.thread_id);
    if (emailErr) console.warn("reassign_lead email cascade failed", { leadId, err: emailErr.message });
    else cascaded = count ?? 0;
  }

  return {
    ok: true,
    detail: {
      reassigned: 1,
      emailsCascaded: cascaded,
      from_rep_id: leadRes.data.assigned_rep_id,
      to_rep: { id: repRes.data.id, name: repRes.data.name },
    },
  };
}

/**
 * reassign_leads_bulk — apply a small ordered rule set. Two-phase:
 * params.confirm !== true returns a preview-only response; confirm:true
 * actually writes. Admin-only.
 */
export async function doReassignLeadsBulk(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  if (session.role !== "admin") {
    return { ok: false, detail: { error: "admin only" } };
  }
  const rules = Array.isArray(params.rules) ? params.rules : [];
  if (rules.length === 0 || rules.length > 5) {
    return { ok: false, detail: { error: "rules[] must have 1-5 entries" } };
  }

  type Predicate = { geo?: "cn" | "edu" | "other"; schoolTier?: number; leadTier?: "strong" | "normal"; currentRepId?: number | null };
  type Rule = { when: Predicate; toRepId: number };
  const norm: Rule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as Record<string, unknown>;
    if (!r || typeof r !== "object") return { ok: false, detail: { error: `rule ${i}: not an object` } };
    const toRepId = Number(r.to_rep_id);
    if (!Number.isFinite(toRepId)) return { ok: false, detail: { error: `rule ${i}: to_rep_id required` } };
    const when = (r.when ?? {}) as Record<string, unknown>;
    if (Object.keys(when).length === 0) return { ok: false, detail: { error: `rule ${i}: when must have at least one field` } };
    const np: Predicate = {};
    if (when.geo !== undefined) {
      if (!["cn", "edu", "other"].includes(String(when.geo))) return { ok: false, detail: { error: `rule ${i}: when.geo must be cn|edu|other` } };
      np.geo = when.geo as "cn" | "edu" | "other";
    }
    if (when.schoolTier !== undefined) {
      const t = Number(when.schoolTier);
      if (![1, 2, 3].includes(t)) return { ok: false, detail: { error: `rule ${i}: when.schoolTier must be 1, 2, or 3` } };
      np.schoolTier = t;
    }
    if (when.leadTier !== undefined) {
      if (!["strong", "normal"].includes(String(when.leadTier))) return { ok: false, detail: { error: `rule ${i}: when.leadTier must be strong|normal` } };
      np.leadTier = when.leadTier as "strong" | "normal";
    }
    if (when.currentRepId !== undefined) {
      if (when.currentRepId === null) np.currentRepId = null;
      else {
        const n = Number(when.currentRepId);
        if (!Number.isFinite(n)) return { ok: false, detail: { error: `rule ${i}: currentRepId must be a number or null` } };
        np.currentRepId = n;
      }
    }
    norm.push({ when: np, toRepId });
  }

  const targetIds = Array.from(new Set(norm.map((r) => r.toRepId)));
  const { data: reps } = await supabase.from("sales_reps").select("id, name, active").in("id", targetIds);
  const repMap = new Map((reps ?? []).map((r) => [r.id as number, r]));
  for (const r of norm) {
    const rep = repMap.get(r.toRepId);
    if (!rep) return { ok: false, detail: { error: `target rep ${r.toRepId} not found` } };
    if (rep.active === false) return { ok: false, detail: { error: `rep ${rep.name} is inactive` } };
  }

  const { data: leads, error: leadsErr } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_email, author_name, school_tier, lead_tier, assigned_rep_id, thread_id")
    .limit(5000);
  if (leadsErr) return { ok: false, detail: { error: leadsErr.message } };

  function geoOf(email: string | null): "cn" | "edu" | "other" {
    const lower = (email ?? "").toLowerCase();
    if (lower.endsWith(".cn")) return "cn";
    if (lower.endsWith(".edu") || lower.endsWith(".edu.cn")) return "edu";
    return "other";
  }
  type LeadLite = { id: string; title: string | null; author_email: string | null; author_name: string | null; school_tier: number | null; lead_tier: string | null; assigned_rep_id: number | null; thread_id: string | null };
  function matches(lead: LeadLite, when: Predicate): boolean {
    if (when.geo !== undefined && geoOf(lead.author_email) !== when.geo) return false;
    if (when.schoolTier !== undefined && lead.school_tier !== when.schoolTier) return false;
    if (when.leadTier !== undefined && lead.lead_tier !== when.leadTier) return false;
    if (when.currentRepId !== undefined) {
      if (when.currentRepId === null && lead.assigned_rep_id !== null) return false;
      if (typeof when.currentRepId === "number" && lead.assigned_rep_id !== when.currentRepId) return false;
    }
    return true;
  }

  type Bucket = { ruleIdx: number; toRepId: number; leads: LeadLite[] };
  const buckets: Bucket[] = norm.map((r, i) => ({ ruleIdx: i, toRepId: r.toRepId, leads: [] }));
  let unmatched = 0;
  for (const l of (leads ?? []) as LeadLite[]) {
    let matched = false;
    for (let i = 0; i < norm.length; i++) {
      if (matches(l, norm[i].when)) {
        if (l.assigned_rep_id !== norm[i].toRepId) buckets[i].leads.push(l);
        matched = true;
        break;
      }
    }
    if (!matched) unmatched++;
  }

  const totalToMove = buckets.reduce((s, b) => s + b.leads.length, 0);
  const perRule = buckets.map((b) => ({
    rule_index: b.ruleIdx,
    to_rep: { id: b.toRepId, name: repMap.get(b.toRepId)?.name ?? `rep ${b.toRepId}` },
    match_count: b.leads.length,
    sample: b.leads.slice(0, 3).map((l) => ({ id: l.id, author_name: l.author_name, title: (l.title ?? "").slice(0, 60) })),
  }));

  if (params.confirm !== true) {
    return {
      ok: true,
      detail: {
        applied: false,
        preview: true,
        total_to_move: totalToMove,
        unmatched,
        per_rule: perRule,
      },
    };
  }

  let totalReassigned = 0;
  let totalCascaded = 0;
  for (const b of buckets) {
    if (b.leads.length === 0) continue;
    const ids = b.leads.map((l) => l.id);
    const threadIds = b.leads.map((l) => l.thread_id).filter((t): t is string => !!t);

    const { error: lErr, count: lCount } = await supabase
      .from("pipeline_leads")
      .update({ assigned_rep_id: b.toRepId }, { count: "exact" })
      .in("id", ids);
    if (lErr) {
      console.warn("doReassignLeadsBulk lead update failed", { ruleIdx: b.ruleIdx, err: lErr.message });
      continue;
    }
    totalReassigned += lCount ?? 0;

    const CHUNK = 150;
    for (let i = 0; i < threadIds.length; i += CHUNK) {
      const chunk = threadIds.slice(i, i + CHUNK);
      const { error: eErr, count: eCount } = await supabase
        .from("emails")
        .update({ rep_id: b.toRepId }, { count: "exact" })
        .in("thread_id", chunk);
      if (eErr) {
        console.warn("doReassignLeadsBulk email cascade chunk failed", { ruleIdx: b.ruleIdx, i, err: eErr.message });
        continue;
      }
      totalCascaded += eCount ?? 0;
    }
  }

  return {
    ok: true,
    detail: {
      applied: true,
      reassigned: totalReassigned,
      emails_cascaded: totalCascaded,
      per_rule: perRule.map((p) => ({ ...p, applied_count: buckets[p.rule_index].leads.length })),
      unmatched,
    },
  };
}
