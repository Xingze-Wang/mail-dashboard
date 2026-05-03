// /congress/proposals/[id] — full discussion thread for a proposal.

import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import { PERSONA_META, type PersonaPosition, type AdversaryAttack } from "@/lib/congress/types";
import { dbToProposal } from "@/lib/congress/adapter";
import { PersonaAvatar } from "@/components/congress/PersonaAvatar";
import { StatusPill } from "@/components/congress/StatusPill";
import DecisionForm from "../../DecisionForm";

export const dynamic = "force-dynamic";

interface DbRow {
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

async function getProposal(id: string): Promise<DbRow | null> {
  const h = await headers();
  const c = await cookies();
  const host = h.get("host") ?? "qiji-pipeline.vercel.app";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const cookieStr = c.getAll().map((x) => `${x.name}=${x.value}`).join("; ");
  const res = await fetch(`${proto}://${host}/api/tactical/${id}`, {
    headers: { cookie: cookieStr },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function ProposalDiscussionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getProposal(id);
  if (!db) notFound();
  const proposal = dbToProposal(db);
  const evidence = db.deliberation?.evidence_pack_excerpt;

  return (
    <>
      <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-500">
          Congress · Weekly · Week {proposal.week} · Proposal {proposal.rank}
        </div>
        <h1 className="mb-2 text-lg font-medium">{proposal.title}</h1>
        <div className="flex items-center gap-3 text-[13px]">
          <StatusPill status={proposal.decision} />
          <span className="text-zinc-500 dark:text-zinc-400">{proposal.vote_summary}</span>
        </div>
      </header>

      <RoundLabel>Round 1 · Position papers</RoundLabel>
      {proposal.positions.length === 0 ? (
        <div className="mb-4 rounded-md bg-zinc-50 p-4 text-[13px] text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
          No persona positions captured for this proposal (older format or stub run).
        </div>
      ) : (
        proposal.positions.map((pos) => <PositionPaper key={pos.persona} position={pos} />)
      )}

      {proposal.attacks.length > 0 && (
        <>
          <RoundLabel>Round 2 · Adversary critiques</RoundLabel>
          {proposal.attacks.map((atk, i) => <AttackBlock key={i} attack={atk} />)}
        </>
      )}

      <section className="my-4 rounded-xl bg-sky-100 p-4 dark:bg-sky-950">
        <div className="mb-2 flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-[13px] font-medium text-sky-800 dark:bg-zinc-900 dark:text-sky-200">
            SY
          </div>
          <div>
            <div className="text-sm font-medium text-sky-900 dark:text-sky-100">Synthesizer · final ranking</div>
            <div className="text-xs text-sky-800/80 dark:text-sky-200/80">Ranked #{proposal.rank} this week</div>
          </div>
        </div>
        <p className="text-[13px] leading-relaxed text-sky-900 dark:text-sky-100">{proposal.synthesizer_ranking}</p>
      </section>

      {proposal.decision === "pending" && (
        <DecisionForm proposalId={proposal.id} voteSummary={proposal.vote_summary} />
      )}

      {/* Change spec — what would actually ship */}
      {db.change_spec && (
        <section className="mt-6 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-2 text-[11px] font-medium tracking-wider text-zinc-500 dark:text-zinc-400">
            Change spec
          </div>
          <div className="mb-1 text-xs uppercase text-sky-700 dark:text-sky-300">
            {db.change_spec.kind ?? "(no kind)"}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
            {JSON.stringify(db.change_spec.details ?? {}, null, 2)}
          </pre>
          {db.expected_lift?.rationale && (
            <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              <strong>Expected lift:</strong> +{db.expected_lift.delta_pp}pp {db.expected_lift.metric}
              <br />
              {db.expected_lift.rationale}
            </div>
          )}
        </section>
      )}

      {/* Outcome (if graded) */}
      {db.actual_lift && (
        <section className="mt-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-2 text-[11px] font-medium tracking-wider text-zinc-500 dark:text-zinc-400">
            Outcome (actual)
          </div>
          <div className="text-[13px] text-zinc-700 dark:text-zinc-300">
            Sent: <strong>{db.actual_lift.sent ?? 0}</strong> · Open rate:{" "}
            <strong>{((db.actual_lift.open_rate ?? 0) * 100).toFixed(2)}%</strong> · Click rate:{" "}
            <strong>{((db.actual_lift.click_rate ?? 0) * 100).toFixed(2)}%</strong>
          </div>
        </section>
      )}

      {evidence && (
        <details className="mt-6">
          <summary className="cursor-pointer text-[11px] font-medium tracking-wider text-zinc-500 dark:text-zinc-400">
            Evidence pack (excerpt)
          </summary>
          <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-[11px] text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
            {evidence}
          </pre>
        </details>
      )}
    </>
  );
}

function RoundLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 mt-6 text-[11px] font-medium tracking-wider text-zinc-500 dark:text-zinc-400">{children}</div>;
}

function PositionPaper({ position }: { position: PersonaPosition }) {
  const meta = PERSONA_META[position.persona];
  return (
    <div className="mb-4 flex gap-3">
      <PersonaAvatar persona={position.persona} />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="text-sm font-medium">{meta.label}</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">{meta.role}</span>
        </div>
        <div className="rounded-md bg-zinc-50 p-3 px-3.5 text-[13px] leading-relaxed dark:bg-zinc-950">
          <p className="m-0 whitespace-pre-wrap">{position.message}</p>
          {position.proposed && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-medium">Proposed:</span> {position.proposed}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AttackBlock({ attack }: { attack: AdversaryAttack }) {
  const targetMeta = PERSONA_META[attack.attacks_persona];
  return (
    <>
      <div className="mb-3 flex gap-3">
        <PersonaAvatar persona="adversary" />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="text-sm font-medium">Adversary</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-500">attacks {targetMeta.label}</span>
          </div>
          <div className="rounded-md bg-zinc-50 p-3 px-3.5 text-[13px] leading-relaxed dark:bg-zinc-950">
            <p className="m-0 whitespace-pre-wrap">{attack.message}</p>
          </div>
        </div>
      </div>
      {attack.rebuttal && (
        <div className="mb-4 ml-8 flex gap-3">
          <PersonaAvatar persona={attack.rebuttal.by_persona} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-500">
              {PERSONA_META[attack.rebuttal.by_persona].label} responds
            </div>
            <div className="rounded-md bg-zinc-50 p-3 px-3.5 text-[13px] leading-relaxed dark:bg-zinc-950">
              {attack.rebuttal.message}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
