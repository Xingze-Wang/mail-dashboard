// src/components/bench/StepDrillDown.tsx
"use client";

import { useState } from "react";
import type { CompanyConfig, StepResult } from "@/lib/bench-sim-types";

const REC_STYLE: Record<string, { label: string; cls: string }> = {
  approve: { label: "Approve", cls: "text-emerald-700 dark:text-emerald-400" },
  reject:  { label: "Reject",  cls: "text-red-700 dark:text-red-400" },
  defer:   { label: "Defer",   cls: "text-amber-700 dark:text-amber-400" },
};

export function StepDrillDown({ result, company, onClose }: {
  result: StepResult;
  company: CompanyConfig;
  onClose: () => void;
}) {
  const [activePersona, setActivePersona] = useState<string | null>(null);
  const personaKeys = Object.keys(result.personas).filter((k) => k !== "synthesizer");
  const recStyle = result.recommendation ? REC_STYLE[result.recommendation] : null;

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/50 p-5 dark:border-sky-900 dark:bg-sky-950/20">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: company.color }} />
            <span className="text-[13px] font-semibold">{company.name}</span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">· Step {result.step + 1} · {result.loop}</span>
          </div>
          {recStyle && (
            <div className={`mt-1 text-[12px] font-semibold ${recStyle.cls}`}>
              {recStyle.label}
              {result.confidence != null && <span className="ml-1 font-normal opacity-70">({Math.round(result.confidence * 100)}%)</span>}
            </div>
          )}
          {result.change && (
            <p className="mt-1 text-[12px] text-zinc-600 dark:text-zinc-400">
              <span className="rounded bg-zinc-200 px-1 text-[10px] dark:bg-zinc-800">{result.change.kind.replace(/_/g, " ")}</span>
              {" "}{result.change.details}
            </p>
          )}
          {result.rationale && (
            <p className="mt-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">&ldquo;{result.rationale}&rdquo;</p>
          )}
        </div>
        <button onClick={onClose} className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          Close ×
        </button>
      </div>

      {Object.entries(result.extra_fields).length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {Object.entries(result.extra_fields).map(([k, v]) => (
            <div key={k} className="rounded-md bg-white px-2.5 py-1.5 dark:bg-zinc-900">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">{k.replace(/_/g, " ")}</div>
              <div className="text-[11px] text-zinc-600 dark:text-zinc-400 line-clamp-2">{v}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-2 flex flex-wrap gap-1">
        {personaKeys.map((k) => (
          <button
            key={k}
            onClick={() => setActivePersona(activePersona === k ? null : k)}
            className={`rounded-md px-2 py-1 text-[10px] font-medium capitalize transition-colors ${
              activePersona === k
                ? "bg-sky-200 text-sky-900 dark:bg-sky-900 dark:text-sky-200"
                : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            }`}
          >
            {k.replace("_", " ")}
          </button>
        ))}
      </div>

      {activePersona && result.personas[activePersona] && (
        <div className="rounded-lg bg-white p-3 dark:bg-zinc-900">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 capitalize">
            {activePersona.replace("_", " ")}
          </div>
          <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
            {result.personas[activePersona]}
          </p>
        </div>
      )}

      {result.error && (
        <div className="mt-2 text-[11px] text-red-600 dark:text-red-400">Error: {result.error}</div>
      )}
    </div>
  );
}
