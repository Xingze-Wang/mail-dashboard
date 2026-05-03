"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DecisionForm({ proposalId, voteSummary }: { proposalId: string; voteSummary: string }) {
  const [acting, setActing] = useState<"approve" | "reject" | "defer" | null>(null);
  const router = useRouter();

  async function decide(kind: "approve" | "reject" | "defer") {
    if (acting) return;
    setActing(kind);
    try {
      // We don't have a /defer endpoint yet — defer maps to reject for now,
      // logged via decided_by. (Strategic congress can re-pick deferred.)
      const approved = kind === "approve" ? "1" : "0";
      const r = await fetch(`/api/tactical/${proposalId}/decide?approved=${approved}`, { method: "POST" });
      if (!r.ok) {
        const text = await r.text();
        alert(`decide failed (${r.status}): ${text.slice(0, 200)}`);
        return;
      }
      router.refresh();
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <button
        type="button"
        disabled={!!acting}
        onClick={() => decide("approve")}
        className="rounded-md border border-sky-300 bg-sky-100 px-3 py-1.5 text-[13px] font-medium text-sky-800 hover:bg-sky-200 disabled:opacity-60 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900"
      >
        {acting === "approve" ? "..." : "Approve & A/B"}
      </button>
      <button
        type="button"
        disabled={!!acting}
        onClick={() => decide("reject")}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-[13px] hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {acting === "reject" ? "..." : "Reject"}
      </button>
      <button
        type="button"
        disabled={!!acting}
        onClick={() => decide("defer")}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-[13px] hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Defer
      </button>
      <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-500">{voteSummary}</span>
    </div>
  );
}
