"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Mail,
  Send,
  BarChart3,
  FileText,
  Inbox,
  Activity,
  Settings,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Overview", icon: BarChart3 },
  { href: "/emails", label: "Emails", icon: Send },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/pipeline", label: "Pipeline", icon: Zap },
  { href: "/logs", label: "Logs", icon: Activity },
  { href: "/templates", label: "Templates", icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-[220px] border-r border-neutral-800 bg-neutral-950 flex flex-col">
      {/* Logo */}
      <div className="flex items-center gap-2 px-5 py-5 border-b border-neutral-800">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-white">
          <Mail className="h-4 w-4 text-black" />
        </div>
        <span className="text-[15px] font-semibold text-white tracking-tight">Mail</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 space-y-0.5">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-neutral-800 px-3 py-3">
        <Link
          href="#"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200 transition-colors"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </div>
    </aside>
  );
}
