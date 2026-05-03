// /congress weekly tactical congress index — current proposals + past decisions.
// Data: GET /api/congress/index (live tactical_proposals + jitr stats).
// Design: drop-in from advisor 2026-05-03. Server component reads via fetch
// at request time so SSR has data.

import Link from "next/link";
import { headers, cookies } from "next/headers";
import { CATEGORY_LABEL, SCOPE_LABEL, type Proposal, type DecisionStatus } from "@/lib/congress/types";
import { dbToProposal } from "@/lib/congress/adapter";
import { StatusPill } from "@/components/congress/StatusPill";
import DecisionForm from "./DecisionForm";

export const dynamic = "force-dynamic";

interface DbProposalRow {
  id: string;
  title: string;
  proposed_at: string;
  ship_decision: string;
  shipped_at: string | null;
  decided_at: string | null;
  evaluation_due_at: string | null;
  weeks_to_evaluate: number;
  expected_lift: { metric?: string; delta_pp?: number; rationale?: string } | null;
  actual_lift: { sent?: number; open_rate?: number; click_rate?: number } | null;
  grade: string | null;
  change_spec: { kind?: string; details?: Record<string, unknown> } | null;
  deliberation: { personas?: Record<string, string>; evidence_pack_excerpt?: string } | null;
}

interface IndexResponse {
  pending: DbProposalRow[];
  recent: DbProposalRow[];
  directives: { id: string; body: string; effective_from: string }[];
  jitr_offers_pending: number;
  jitr_offers_accepted_30d: number;
  unbound_reps: string[];
}

async function getIndex(): Promise<IndexResponse | null> {
  const h = await headers();
  const c = await cookies();
  const host = h.get("host") ?? "qiji-pipeline.vercel.app";
  const proto = host.startsWith("localhost") ? "http" : "https";
  // Forward cookies for auth
  const cookieStr = c.getAll().map((x) => `${x.name}=${x.value}`).join("; ");
  const res = await fetch(`${proto}://${host}/api/congress/index`, {
    headers: { cookie: cookieStr },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function CongressWeeklyPage() {
  const data = await getIndex();
  if (!data) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-[13px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Unable to load congress data — sign in as admin.
      </div>
    );
  }

  const pending = data.pending.map(dbToProposal);
  const recent = data.recent.map(dbToProposal);

  // Header summary stats
  const shippedCount = recent.filter((p) => p.decision === "approved" || p.decision === "measuring").length;
  const revertedCount = recent.filter((p) => p.decision === "reverted").length;
  const measuringCount = recent.filter((p) => p.decision === "measuring").length;
  const currentWeek = pending[0]?.week ?? recent[0]?.week ?? "—";

  return (
    <>
      <header className="mb-6 flex items-end justify-between border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-500">Congress · Weekly</div>
          <h1 className="text-lg font-medium">Tactical congress · week {currentWeek}</h1>
          <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
            {pending.length === 0 ? "No new proposals this week" : `${pending.length} proposal${pending.length === 1 ? "" : "s"} pending decision`}
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="text-zinc-500 dark:text-zinc-500">Last 4 weeks</div>
          <div>
            <span className="font-medium text-emerald-700 dark:text-emerald-400">{shippedCount} shipped</span>{" "}
            ·{" "}
            <span className="font-medium text-red-700 dark:text-red-400">{revertedCount} reverted</span>{" "}
            ·{" "}
            <span className="font-medium text-zinc-600 dark:text-zinc-400">{measuringCount} measuring</span>
          </div>
        </div>
      </header>

      {pending.length === 0 ? (
        <div className="mb-8 rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center text-[13px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          Nothing pending. Loop 2 runs Monday 1am UTC.
        </div>
      ) : (
        pending.map((p) => <ProposalCard key={p.id} proposal={p} />)
      )}

      <section className="mt-8">
        <h2 className="text-base font-medium">Past decisions</h2>
        <div className="mt-2 text-[13px]">
          {recent.length === 0 ? (
            <div className="py-6 text-center text-zinc-500 dark:text-zinc-400">No decisions yet.</div>
          ) : (
            recent.map((d, i) => (
              <Link
                key={d.id}
                href={`/congress/proposals/${d.id}`}
                className={`flex items-center gap-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                  i < recent.length - 1 ? "border-b border-zinc-200 dark:border-zinc-800" : ""
                }`}
              >
                <span className="min-w-[44px] text-xs text-zinc-500 dark:text-zinc-500">W{d.week}</span>
                <StatusPill status={d.decision} />
                <span className="flex-1 truncate">{d.title}</span>
                <span
                  className={
                    d.outcome_lift?.startsWith("+")
                      ? "font-medium text-emerald-700 dark:text-emerald-400"
                      : d.outcome_lift?.startsWith("−") || d.outcome_lift?.startsWith("-")
                        ? "font-medium text-red-700 dark:text-red-400"
                        : "text-zinc-500 dark:text-zinc-400"
                  }
                >
                  {d.outcome_lift ?? d.outcome_status ?? "—"}
                </span>
              </Link>
            ))
          )}
        </div>
      </section>

      {/* Active strategic directives — what currently constrains Loop 2 */}
      {data.directives.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-medium">Active strategic directives</h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Loop 2 reads these as constraints every week.
          </p>
          <div className="mt-2 text-[13px]">
            {data.directives.map((d) => (
              <div key={d.id} className="rounded-md bg-zinc-50 p-3 px-3.5 dark:bg-zinc-900 mb-2">
                <p className="m-0">{d.body}</p>
                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Effective {new Date(d.effective_from).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* JITR daily — the apprentice's pulse */}
      <section className="mt-8">
        <h2 className="text-base font-medium">Daily JITR (Loop 1)</h2>
        <div className="mt-2 grid grid-cols-3 gap-3 text-[13px]">
          <Stat label="Offers pending" value={data.jitr_offers_pending} />
          <Stat label="Accepts (30d)" value={data.jitr_offers_accepted_30d} />
          <Stat label="Unbound reps" value={data.unbound_reps.length} />
        </div>
        {data.unbound_reps.length > 0 && (
          <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Unbound: {data.unbound_reps.join(", ")} — they need to DM the bot once.
          </div>
        )}
      </section>
    </>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const firstPos = proposal.positions[0];
  const adv = proposal.attacks[0];
  return (
    <article className="mb-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200">
            {CATEGORY_LABEL[proposal.category] ?? proposal.category}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            Scope: {SCOPE_LABEL[proposal.scope]}
          </span>
        </div>
        <span className="text-xs text-zinc-500 dark:text-zinc-500">
          Est. {proposal.stats.weeks_to_significance}w to verify
        </span>
      </div>

      <h3 className="mb-3.5 text-base font-medium">
        <Link href={`/congress/proposals/${proposal.id}`} className="hover:underline">
          {proposal.title}
        </Link>
      </h3>

      <div className="mb-3.5 grid grid-cols-2 gap-3">
        {firstPos && (
          <QuoteCard speaker={firstPos.persona.replace("_", " ")} text={firstPos.message} />
        )}
        {adv ? (
          <QuoteCard speaker="Adversary counters" text={adv.message} />
        ) : (
          proposal.positions[1] && (
            <QuoteCard speaker={proposal.positions[1].persona.replace("_", " ")} text={proposal.positions[1].message} />
          )
        )}
      </div>

      <div className="mb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Evidence</div>
      <div className="mb-3.5 rounded-md bg-zinc-50 p-2 px-3 font-mono text-xs leading-relaxed dark:bg-zinc-950">
        sample {proposal.stats.sample_size} · baseline {proposal.stats.baseline} · projected Δ {proposal.stats.projected_delta} · rollback {proposal.stats.rollback}
      </div>

      <DecisionForm proposalId={proposal.id} voteSummary={proposal.vote_summary} />
    </article>
  );
}

function QuoteCard({ speaker, text }: { speaker: string; text: string }) {
  return (
    <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-950">
      <div className="mb-1 text-[11px] font-medium capitalize text-zinc-500 dark:text-zinc-400">{speaker}</div>
      <p className="text-[13px] leading-relaxed">{text}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
      <div className="text-[22px] font-medium">{value}</div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
    </div>
  );
}

// keep DecisionStatus referenced so unused-import lint stays clean
export type _D = DecisionStatus;
