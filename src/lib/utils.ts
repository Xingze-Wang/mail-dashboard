import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string) {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function getStatusColor(status: string) {
  switch (status) {
    case "delivered":
      return "text-[var(--green)]";
    case "sent":
      return "text-[var(--blue)]";
    case "opened":
      return "text-[var(--purple)]";
    case "clicked":
      return "text-[var(--blue)]";
    case "bounced":
      return "text-[var(--coral)]";
    case "complained":
      return "text-[#C2410C]";
    case "queued":
      return "text-[var(--text-secondary)]";
    default:
      return "text-[var(--text-tertiary)]";
  }
}

export function getStatusDot(status: string) {
  switch (status) {
    case "delivered":
      return "bg-[var(--green)]";
    case "sent":
      return "bg-[var(--blue)]";
    case "opened":
      return "bg-[var(--purple)]";
    case "clicked":
      return "bg-[var(--blue)]";
    case "bounced":
      return "bg-[var(--coral)]";
    case "complained":
      return "bg-[#C2410C]";
    case "queued":
      return "bg-[var(--text-secondary)]";
    default:
      return "bg-[var(--text-tertiary)]";
  }
}

export function generateThreadId() {
  return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
