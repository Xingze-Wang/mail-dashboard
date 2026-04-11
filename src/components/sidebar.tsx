"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Mail,
  Send,
  BarChart3,
  Inbox,
  Activity,
  Settings,
  Zap,
  User,
  Brain,
  FileText,
} from "lucide-react";

const mainNav = [
  { href: "/", label: "Overview", icon: BarChart3 },
  { href: "/pipeline", label: "Pipeline", icon: Zap },
  { href: "/emails", label: "Emails", icon: Send },
  { href: "/inbox", label: "Inbox", icon: Inbox },
];

const toolsNav = [
  { href: "/brief", label: "Lookup", icon: User },
  { href: "/scorer", label: "Scorer", icon: Brain },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/logs", label: "Logs", icon: Activity },
];

function NavItem({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`
        flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-all duration-150
        ${active
          ? "bg-white/[0.08] text-white"
          : "text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300"
        }
      `}
    >
      <Icon className={`h-[18px] w-[18px] ${active ? "text-white" : "text-neutral-600"}`} />
      {label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside className="app-sidebar">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 h-14 border-b border-white/[0.06] shrink-0">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white">
          <Mail className="h-4 w-4 text-black" />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">Mail</span>
      </div>

      {/* Main navigation */}
      <nav className="flex-1 px-3 pt-4 space-y-6">
        <div>
          <div className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-600">
            Main
          </div>
          <div className="space-y-0.5">
            {mainNav.map((item) => (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isActive(item.href)}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-600">
            Tools
          </div>
          <div className="space-y-0.5">
            {toolsNav.map((item) => (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isActive(item.href)}
              />
            ))}
          </div>
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-white/[0.06] px-3 py-3 shrink-0">
        <NavItem href="/settings" label="Settings" icon={Settings} active={false} />
      </div>
    </aside>
  );
}
