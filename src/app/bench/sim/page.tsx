// src/app/bench/sim/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Play } from "lucide-react";
import { CompanyCard } from "@/components/bench/CompanyCard";
import { SimTimeline } from "@/components/bench/SimTimeline";
import { StepDrillDown } from "@/components/bench/StepDrillDown";
import { CONGRESS_SAMPLES } from "@/lib/bench-congress";
import type { CompanyConfig, SimSession, StepResult } from "@/lib/bench-sim-types";

const DEFAULT_ROSTER = {
  daily_model: "gemini-2.5-flash",
  weekly_persona_model: {},
  weekly_default: "gemini-2.5-flash",
  weekly_synth_model: "claude-sonnet-4-6",
  monthly_persona_model: {},
  monthly_default: "claude-sonnet-4-6",
  monthly_synth_model: "claude-sonnet-4-6",
  quarterly_model: "claude-sonnet-4-6",
};

const PRESET_COMPANIES: Omit<CompanyConfig, "id" | "created_at">[] = [
  {
    name: "Frontier Synth",
    tagline: "Expensive top-tier models everywhere. Does it pay off?",
    deliberation_style: "expansionist",
    model_roster: { ...DEFAULT_ROSTER, weekly_default: "claude-sonnet-4-6", weekly_synth_model: "claude-opus-4-7", monthly_default: "claude-sonnet-4-6", monthly_synth_model: "claude-opus-4-7" },
    persona_overrides: {},
    customer_profile: { segment: "top_tier_academia", communication_style: "formal" },
    color: "#8b5cf6",
  },
  {
    name: "Lean Fleet",
    tagline: "Fast cheap models for personas, frontier only for synth.",
    deliberation_style: "empiricist",
    model_roster: { ...DEFAULT_ROSTER, weekly_default: "gemini-2.5-flash", weekly_synth_model: "claude-sonnet-4-6", monthly_default: "gemini-2.5-flash", monthly_synth_model: "claude-sonnet-4-6" },
    persona_overrides: {},
    customer_profile: { segment: "mid_tier_startup", communication_style: "direct" },
    color: "#0ea5e9",
  },
  {
    name: "Cautious Council",
    tagline: "Conservative style, mixed models. Rarely approves.",
    deliberation_style: "conservative",
    model_roster: { ...DEFAULT_ROSTER, weekly_synth_model: "gemini-2.5-flash", monthly_synth_model: "claude-sonnet-4-6" },
    persona_overrides: {
      adversary: { system: "你的工作是 attack 任何提议的改动. 你极度悲观. 默认 defer.", question: "What is the single most likely failure mode? Give a concrete scenario where this causes net harm." },
    },
    customer_profile: { segment: "gov_lab", communication_style: "formal" },
    color: "#64748b",
  },
];

export default function SimPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [sessions, setSessions] = useState<SimSession[]>([]);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [activeSession, setActiveSession] = useState<{ session: SimSession; results: StepResult[] } | null>(null);
  const [activeCell, setActiveCell] = useState<{ companyId: string; step: number; loop: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewSessionForm, setShowNewSessionForm] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [selectedScenario, setSelectedScenario] = useState(CONGRESS_SAMPLES[0].id);
  const [stepsPlanned, setStepsPlanned] = useState(4);
  const [crossVisibility, setCrossVisibility] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d.authenticated && d.role === "admin") setGated("allowed");
      else { setGated("forbidden"); router.replace("/"); }
    }).catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/bench/sim");
    if (!r.ok) return;
    const d = await r.json();
    setCompanies(d.companies ?? []);
    setSessions(d.sessions ?? []);
  }, []);

  useEffect(() => { if (gated === "allowed") refresh(); }, [gated, refresh]);

  const loadSession = useCallback(async (sessionId: string) => {
    const r = await fetch(`/api/bench/sim/${sessionId}`);
    if (!r.ok) return;
    const d = await r.json();
    setActiveSession({ session: d.session, results: d.results ?? [] });
    setActiveCell(null);
  }, []);

  const createPresetCompanies = async () => {
    setCreating(true);
    for (const preset of PRESET_COMPANIES) {
      await fetch("/api/bench/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_company", company: preset }),
      });
    }
    await refresh();
    setCreating(false);
  };

  const createSession = async () => {
    if (selectedCompanyIds.size < 1) { setError("Select at least one company"); return; }
    if (!sessionName.trim()) { setError("Session name required"); return; }
    setError(null);
    const r = await fetch("/api/bench/sim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_session",
        name: sessionName.trim(),
        scenario_id: selectedScenario,
        company_ids: [...selectedCompanyIds],
        steps_planned: stepsPlanned,
        cross_company_visibility: crossVisibility,
      }),
    });
    const d = await r.json();
    if (!r.ok) { setError(d.error); return; }
    await refresh();
    await loadSession(d.session.id);
    setShowNewSessionForm(false);
    setSessionName("");
  };

  const runNextStep = async () => {
    if (!activeSession) return;
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/bench/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_step", session_id: activeSession.session.id }),
      });
      if (!r.ok) { const d = await r.json(); setError(d.error); return; }
      await loadSession(activeSession.session.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  if (gated !== "allowed") {
    return <div className="flex justify-center p-24"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const activeCompanies = activeSession
    ? companies.filter((c) => (activeSession.session.company_ids as string[]).includes(c.id))
    : [];
  const activeCellResult = activeCell
    ? activeSession?.results.find((r) => r.company_id === activeCell.companyId && r.step === activeCell.step && r.loop === activeCell.loop) ?? null
    : null;
  const activeCellCompany = activeCell ? companies.find((c) => c.id === activeCell.companyId) ?? null : null;

  return (
    <>
      <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-500">Bench · Simulation</div>
        <h1 className="text-lg font-medium">Company congress simulation</h1>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Multiple companies, each with its own four-loop congress architecture and model roster, run the same scenario. Watch trajectories diverge.
        </p>
      </header>

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Companies ({companies.length})
          </div>
          <button
            onClick={createPresetCompanies}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-1.5 text-[12px] text-zinc-700 hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add presets
          </button>
        </div>
        {companies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-[13px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
            No companies yet. Click &quot;Add presets&quot; to start with 3 example companies.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {companies.map((c) => (
              <CompanyCard
                key={c.id}
                company={c}
                selected={selectedCompanyIds.has(c.id)}
                onSelect={() => {
                  const next = new Set(selectedCompanyIds);
                  if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                  setSelectedCompanyIds(next);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Simulation session
          </div>
          {sessions.length > 0 && (
            <select
              className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[12px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              onChange={(e) => e.target.value && loadSession(e.target.value)}
              defaultValue=""
            >
              <option value="">Load session…</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.steps_completed}/{s.steps_planned} steps)</option>
              ))}
            </select>
          )}
        </div>

        {!showNewSessionForm ? (
          <button
            onClick={() => setShowNewSessionForm(true)}
            className="inline-flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-4 py-2 text-[12px] text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
          >
            <Plus className="h-3.5 w-3.5" /> New session
          </button>
        ) : (
          <div className="space-y-3">
            <input
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="Session name (e.g. 'May week 1 — frontier vs lean')"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-[13px] dark:border-zinc-700 dark:bg-zinc-800"
            />
            <div className="flex flex-wrap gap-3 text-[12px]">
              <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                Scenario:
                <select
                  value={selectedScenario}
                  onChange={(e) => setSelectedScenario(e.target.value)}
                  className="rounded border border-zinc-200 px-2 py-0.5 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  {CONGRESS_SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                Steps:
                <input
                  type="number" min={1} max={12}
                  value={stepsPlanned}
                  onChange={(e) => setStepsPlanned(Number(e.target.value))}
                  className="w-12 rounded border border-zinc-200 px-2 py-0.5 text-center dark:border-zinc-700 dark:bg-zinc-800"
                />
              </label>
              <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={crossVisibility} onChange={(e) => setCrossVisibility(e.target.checked)} />
                Companies see each other
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={createSession} className="rounded-md bg-sky-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-sky-700">
                Create session
              </button>
              <button onClick={() => setShowNewSessionForm(false)} className="text-[12px] text-zinc-400 hover:text-zinc-600">
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <div className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</div>}
      </section>

      {activeSession && (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-medium">{activeSession.session.name}</h2>
              <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                Step {activeSession.session.steps_completed} of {activeSession.session.steps_planned} ·{" "}
                {activeSession.session.cross_company_visibility ? "companies observe each other" : "isolated"}
              </p>
            </div>
            <button
              onClick={runNextStep}
              disabled={running || activeSession.session.status === "complete"}
              className="inline-flex items-center gap-2 rounded-md border border-sky-300 bg-sky-100 px-4 py-2 text-[13px] font-medium text-sky-800 hover:bg-sky-200 disabled:opacity-60 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? "Running…" : activeSession.session.status === "complete" ? "Complete" : "Run next step"}
            </button>
          </div>

          <SimTimeline
            companies={activeCompanies}
            results={activeSession.results}
            stepsCompleted={activeSession.session.steps_completed}
            onCellClick={(companyId, step, loop) => setActiveCell({ companyId, step, loop })}
            activeCell={activeCell}
          />

          {activeCellResult && activeCellCompany && (
            <div className="mt-4">
              <StepDrillDown
                result={activeCellResult}
                company={activeCellCompany}
                onClose={() => setActiveCell(null)}
              />
            </div>
          )}
        </section>
      )}

      {activeSession && activeSession.session.steps_completed >= 2 && (
        <CustomerFitSummary companies={activeCompanies} results={activeSession.results} />
      )}
    </>
  );
}

function CustomerFitSummary({ companies, results }: { companies: CompanyConfig[]; results: StepResult[] }) {
  const weeklyResults = results.filter((r) => r.loop === "weekly");

  const stats = companies.map((c) => {
    const myResults = weeklyResults.filter((r) => r.company_id === c.id);
    const total = myResults.length;
    const approvals = myResults.filter((r) => r.recommendation === "approve").length;
    const avgConfidence = myResults.reduce((sum, r) => sum + (r.confidence ?? 0), 0) / (total || 1);
    return { company: c, approvals, total, approvalRate: total > 0 ? approvals / total : 0, avgConfidence };
  });

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/50 p-5 dark:border-violet-900 dark:bg-violet-950/10">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-violet-500 dark:text-violet-400">
        Customer fit signal
      </div>
      <p className="mb-3 text-[12px] text-zinc-500 dark:text-zinc-400">
        Which congress architecture approves most aggressively — and which customer segment does that fit?
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.sort((a, b) => b.approvalRate - a.approvalRate).map(({ company, approvals, total, approvalRate, avgConfidence }) => (
          <div key={company.id} className="rounded-lg bg-white p-3 dark:bg-zinc-900">
            <div className="mb-1 flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: company.color }} />
              <span className="text-[12px] font-medium">{company.name}</span>
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {approvals}/{total} approved · {Math.round(approvalRate * 100)}% rate · {Math.round(avgConfidence * 100)}% avg confidence
            </div>
            <div className="mt-1 text-[10px] text-violet-600 dark:text-violet-400">
              → Deploy for: {company.customer_profile?.segment?.replace(/_/g, " ") ?? "unknown"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
