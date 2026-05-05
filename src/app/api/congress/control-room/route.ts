// GET /api/congress/control-room — vital signs for /congress weekly index.
// Pulls everything one screen needs: pending proposals, this-week capital
// deployed, editor verdicts pending, top conviction mover, JITR stats,
// active directives, recent contract outcomes.
//
// One denormalized payload, designed to render a control-room view.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export interface VitalSign {
  label: string;
  value: number | string;
  delta?: string;            // e.g. "+3 vs last wk"
  href?: string;             // click target
  tone?: "neutral" | "warn" | "good" | "bad";
}

export interface PendingProposal {
  id: string;
  company_name: string;
  company_color: string;
  kind: string;
  prediction: string;
  state: string;
  editor_verdict: string | null;
  editor_issues: string[];
  created_at: string;
  expires_in_days: number;
}

export interface RecentContract {
  id: string;
  company_name: string;
  company_color: string;
  action_label: string;
  segment: string | null;
  state: string;             // hit / missed / open
  target_score: number;
  running_score: number;
  settled_at: string | null;
  opened_at: string;
}

export interface ConvictionShift {
  company_id: string;
  company_name: string;
  company_color: string;
  prior: number;
  next: number;
  action: string;
  occurred_at: string;
}

export interface ControlRoomPayload {
  vitals: VitalSign[];
  pending_proposals: PendingProposal[];
  recent_contracts: RecentContract[];
  top_movers: ConvictionShift[];
  active_directives: Array<{ id: string; body: string; effective_from: string }>;
  jitr_pending: number;
  jitr_accepted_30d: number;
  unbound_reps: string[];
  generated_at: string;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const now = Date.now();
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
  const twoWeeksAgo = new Date(now - 14 * 86_400_000).toISOString();

  const [
    { data: pendingProposals },
    { data: contracts },
    { data: convChanges },
    { data: directives },
    { count: jitrPending },
    { count: jitrAccepted30d },
    { data: ledger7d },
    { data: ledger14_7d },
    { data: editorBlocks },
    { data: appeals },
    { data: reps },
  ] = await Promise.all([
    supabase
      .from("company_proposals")
      .select("id, company_id, kind, prediction, state, created_at, expires_at, editor_review:editor_reviews(verdict, feedback), company:bench_companies(name, color)")
      .in("state", ["admin_review", "editor_review"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("company_contracts")
      .select("id, company_id, action_label, segment, state, target_score, running_score, opened_at, settled_at, company:bench_companies(name, color)")
      .order("settled_at", { ascending: false, nullsFirst: false })
      .limit(12),
    supabase
      .from("company_lifecycle")
      .select("company_id, label, meta, occurred_at, company:bench_companies(name, color)")
      .eq("event", "conviction_change")
      .gte("occurred_at", weekAgo)
      .order("occurred_at", { ascending: false }),
    supabase.from("strategic_directives").select("id, body, effective_from").eq("active", true).order("effective_from", { ascending: false }),
    supabase.from("jitr_offers").select("*", { count: "exact", head: true }).eq("decision", "pending"),
    supabase.from("jitr_offers").select("*", { count: "exact", head: true }).eq("decision", "accept").gte("offered_at", new Date(now - 30 * 86_400_000).toISOString()),
    supabase.from("investor_capital_ledger").select("kind, delta").gte("occurred_at", weekAgo).eq("kind", "stake"),
    supabase.from("investor_capital_ledger").select("kind, delta").gte("occurred_at", twoWeeksAgo).lt("occurred_at", weekAgo).eq("kind", "stake"),
    supabase.from("editor_reviews").select("*", { count: "exact", head: true }).eq("verdict", "block"),
    supabase.from("editor_appeals").select("*", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("sales_reps").select("name, lark_open_id").eq("active", true),
  ]);

  // Capital deployed this week (sum of |stake delta|).
  const capDeployedThis = (ledger7d ?? []).reduce((s, r) => s + Math.abs(Number(r.delta)), 0);
  const capDeployedPrev = (ledger14_7d ?? []).reduce((s, r) => s + Math.abs(Number(r.delta)), 0);
  const capDelta = capDeployedThis - capDeployedPrev;

  // Top movers: largest absolute conviction change in the last week.
  const movers: ConvictionShift[] = (convChanges ?? [])
    .map((e) => {
      const meta = (e.meta ?? {}) as Record<string, unknown>;
      const prior = Number(meta.prior ?? 0);
      const next = Number(meta.next ?? 0);
      const co = e.company as unknown as { name: string; color: string } | null;
      return {
        company_id: e.company_id as string,
        company_name: co?.name ?? "?",
        company_color: co?.color ?? "#3B82F6",
        prior,
        next,
        action: String(meta.action ?? ""),
        occurred_at: e.occurred_at as string,
      };
    })
    .sort((a, b) => Math.abs(b.next - b.prior) - Math.abs(a.next - a.prior))
    .slice(0, 4);

  // Pending proposals: shape for the queue cards.
  const pp: PendingProposal[] = (pendingProposals ?? []).map((p) => {
    const review = (p.editor_review ?? null) as unknown as { verdict?: string; feedback?: { issues?: string[] } } | null;
    const co = p.company as unknown as { name: string; color: string } | null;
    const expDays = Math.max(0, Math.round((new Date(p.expires_at as string).getTime() - now) / 86_400_000));
    return {
      id: p.id as string,
      company_name: co?.name ?? "?",
      company_color: co?.color ?? "#3B82F6",
      kind: p.kind as string,
      prediction: p.prediction as string,
      state: p.state as string,
      editor_verdict: review?.verdict ?? null,
      editor_issues: review?.feedback?.issues ?? [],
      created_at: p.created_at as string,
      expires_in_days: expDays,
    };
  });

  // Recent contracts.
  const rc: RecentContract[] = (contracts ?? []).map((c) => {
    const co = c.company as unknown as { name: string; color: string } | null;
    return {
      id: c.id as string,
      company_name: co?.name ?? "?",
      company_color: co?.color ?? "#3B82F6",
      action_label: c.action_label as string,
      segment: (c.segment as string | null) ?? null,
      state: c.state as string,
      target_score: Number(c.target_score),
      running_score: Number(c.running_score),
      settled_at: (c.settled_at as string | null) ?? null,
      opened_at: c.opened_at as string,
    };
  });

  const unboundReps = (reps ?? [])
    .filter((r) => !r.lark_open_id && r.name !== "Xingze Wang")
    .map((r) => r.name as string);

  const vitals: VitalSign[] = [
    {
      label: "Proposals pending",
      value: pp.filter((p) => p.state === "admin_review").length,
      tone: pp.filter((p) => p.state === "admin_review").length > 0 ? "warn" : "neutral",
      href: "/editor",
    },
    {
      label: "Capital this week",
      value: capDeployedThis.toFixed(0),
      delta: capDelta === 0 ? "flat" : `${capDelta > 0 ? "+" : ""}${capDelta.toFixed(0)} vs prev wk`,
      tone: capDelta > 0 ? "good" : capDelta < 0 ? "warn" : "neutral",
    },
    {
      label: "Editor blocks",
      value: editorBlocks?.length ?? 0,
      tone: "neutral",
      href: "/editor",
    },
    {
      label: "Appeals open",
      value: appeals?.length ?? 0,
      tone: (appeals?.length ?? 0) > 0 ? "warn" : "neutral",
      href: "/editor",
    },
    {
      label: "Top mover",
      value: movers[0] ? `${movers[0].company_name}` : "—",
      delta: movers[0] ? `${movers[0].prior.toFixed(2)} → ${movers[0].next.toFixed(2)}` : undefined,
      tone: movers[0] ? (movers[0].next > movers[0].prior ? "good" : "bad") : "neutral",
      href: "/congress/timeline",
    },
  ];

  const payload: ControlRoomPayload = {
    vitals,
    pending_proposals: pp,
    recent_contracts: rc,
    top_movers: movers,
    active_directives: (directives ?? []) as Array<{ id: string; body: string; effective_from: string }>,
    jitr_pending: jitrPending ?? 0,
    jitr_accepted_30d: jitrAccepted30d ?? 0,
    unbound_reps: unboundReps,
    generated_at: new Date().toISOString(),
  };
  return NextResponse.json(payload);
}
