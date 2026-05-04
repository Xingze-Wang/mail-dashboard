// src/components/bench/CompanyCard.tsx
"use client";

import type { CompanyConfig } from "@/lib/bench-sim-types";

const STYLE_LABEL: Record<string, string> = {
  conservative: "Conservative",
  expansionist: "Expansionist",
  empiricist: "Empiricist",
  balanced: "Balanced",
};

const SEGMENT_LABEL: Record<string, string> = {
  top_tier_academia: "Top-tier academia",
  mid_tier_startup: "Mid-tier startup",
  gov_lab: "Gov lab",
  industry_research: "Industry research",
  unknown: "Unknown",
};

export function CompanyCard({ company, selected, onSelect }: {
  company: CompanyConfig;
  selected: boolean;
  onSelect?: () => void;
}) {
  const roster = company.model_roster;

  return (
    <div
      onClick={onSelect}
      className={`rounded-xl border bg-white p-4 dark:bg-zinc-900 transition-all cursor-pointer ${
        selected
          ? "border-sky-400 ring-2 ring-sky-200 dark:border-sky-600 dark:ring-sky-900"
          : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
      }`}
      style={{ borderLeftColor: company.color, borderLeftWidth: 4 }}
    >
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-semibold">{company.name}</div>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {STYLE_LABEL[company.deliberation_style] ?? company.deliberation_style}
        </span>
      </div>
      <div className="mb-2 text-[11px] text-zinc-500 dark:text-zinc-400">{company.tagline}</div>

      <div className="mb-2 space-y-0.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Models</div>
        <div className="flex flex-wrap gap-1">
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            W·synth: {roster.weekly_synth_model}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            W·default: {roster.weekly_default}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            M·synth: {roster.monthly_synth_model}
          </span>
        </div>
      </div>

      {company.customer_profile?.segment && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">Best for:</span>
          <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            {SEGMENT_LABEL[company.customer_profile.segment] ?? company.customer_profile.segment}
          </span>
        </div>
      )}
    </div>
  );
}
