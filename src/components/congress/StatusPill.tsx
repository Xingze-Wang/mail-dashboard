import type { DecisionStatus } from "@/lib/congress/types";

const STYLES: Record<DecisionStatus, string> = {
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  rejected: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  reverted: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  measuring: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  deferred: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
};

const LABEL: Record<DecisionStatus, string> = {
  approved: "Approved",
  rejected: "Rejected",
  reverted: "Reverted",
  pending: "Pending",
  measuring: "Measuring",
  deferred: "Deferred",
};

export function StatusPill({ status }: { status: DecisionStatus }) {
  const cls = STYLES[status] ?? STYLES.pending;
  const label = LABEL[status] ?? status;
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

export const STATUS_DOT_BG: Record<DecisionStatus, string> = {
  approved: "bg-emerald-600 dark:bg-emerald-400",
  rejected: "bg-zinc-400 dark:bg-zinc-500",
  reverted: "bg-red-600 dark:bg-red-400",
  pending: "bg-amber-600 dark:bg-amber-400",
  measuring: "bg-sky-600 dark:bg-sky-400",
  deferred: "bg-violet-600 dark:bg-violet-400",
};
