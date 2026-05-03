import Link from "next/link";
import type { ReactNode } from "react";

export default function CongressLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 text-zinc-900 dark:text-zinc-100">
      <nav className="mb-6 flex gap-4 text-[13px] text-zinc-500 dark:text-zinc-400">
        <Link href="/congress" className="hover:text-zinc-900 dark:hover:text-zinc-100">
          Weekly
        </Link>
        <Link href="/congress/history" className="hover:text-zinc-900 dark:hover:text-zinc-100">
          History
        </Link>
        <Link href="/congress/architecture" className="hover:text-zinc-900 dark:hover:text-zinc-100">
          Architecture
        </Link>
      </nav>
      {children}
    </div>
  );
}
