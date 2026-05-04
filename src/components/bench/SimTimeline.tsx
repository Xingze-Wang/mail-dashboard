"use client";

import type { CompanyConfig, StepResult } from "@/lib/bench-sim-types";

interface Props {
  companies: CompanyConfig[];
  results: StepResult[];
  stepsCompleted: number;
  onCellClick: (companyId: string, step: number, loop: string) => void;
  activeCell: { companyId: string; step: number; loop: string } | null;
}

const REC_COLOR: Record<string, string> = {
  approve: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  reject:  "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  defer:   "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

export function SimTimeline({ companies, results, stepsCompleted, onCellClick, activeCell }: Props) {
  const steps = Array.from({ length: stepsCompleted }, (_, i) => i);

  if (steps.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center text-[13px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        No steps run yet. Click &quot;Run next step&quot; to start.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:bg-zinc-950 dark:text-zinc-500 w-36">
              Company
            </th>
            {steps.map((s) => {
              const isMonthly = (s + 1) % 4 === 0;
              return (
                <th key={s} className="px-2 py-2 text-center text-[10px] text-zinc-400 dark:text-zinc-500">
                  <div className="font-medium">W{s + 1}</div>
                  {isMonthly && <div className="text-[9px] text-violet-500">+M</div>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => (
            <tr key={company.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="sticky left-0 z-10 bg-white px-3 py-2 dark:bg-zinc-950">
                <div className="flex items-center gap-1.5">
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: company.color }}
                  />
                  <span className="truncate font-medium text-zinc-700 dark:text-zinc-300 max-w-[100px]">
                    {company.name}
                  </span>
                </div>
              </td>
              {steps.map((s) => {
                const weeklyResult = results.find((r) => r.company_id === company.id && r.step === s && r.loop === "weekly");
                const monthlyResult = results.find((r) => r.company_id === company.id && r.step === s && r.loop === "monthly");
                const isActive = activeCell?.companyId === company.id && activeCell?.step === s && activeCell?.loop === "weekly";
                const rec = weeklyResult?.recommendation;

                const allWeeklyRecs = companies.map((c) =>
                  results.find((r) => r.company_id === c.id && r.step === s && r.loop === "weekly")?.recommendation,
                ).filter(Boolean);
                const isDivergent = allWeeklyRecs.length > 1 && new Set(allWeeklyRecs).size > 1;

                return (
                  <td key={s} className="px-1 py-1">
                    <button
                      onClick={() => weeklyResult && onCellClick(company.id, s, "weekly")}
                      className={`w-full rounded-md px-2 py-1.5 text-center transition-all ${
                        rec ? REC_COLOR[rec] : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
                      } ${isActive ? "ring-2 ring-sky-400" : isDivergent ? "ring-1 ring-amber-400" : ""}`}
                    >
                      <div className="text-[11px] font-semibold capitalize">{rec ?? "—"}</div>
                      {weeklyResult?.confidence != null && (
                        <div className="text-[9px] opacity-70">{Math.round(weeklyResult.confidence * 100)}%</div>
                      )}
                      {monthlyResult && (
                        <div className="mt-0.5 text-[9px] text-violet-600 dark:text-violet-400">
                          M·{monthlyResult.recommendation ?? "—"}
                        </div>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-t border-zinc-200 dark:border-zinc-700">
            <td className="sticky left-0 z-10 bg-white px-3 py-1 text-[10px] text-zinc-400 dark:bg-zinc-950 dark:text-zinc-500">
              Agreement
            </td>
            {steps.map((s) => {
              const recs = companies.map((c) =>
                results.find((r) => r.company_id === c.id && r.step === s && r.loop === "weekly")?.recommendation
              ).filter(Boolean);
              const unanimous = recs.length > 0 && new Set(recs).size === 1;
              return (
                <td key={s} className="px-1 py-1 text-center">
                  {recs.length === 0 ? (
                    <span className="text-[10px] text-zinc-300 dark:text-zinc-700">—</span>
                  ) : unanimous ? (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                      ✓
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
                      split
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
