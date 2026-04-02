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
      return "text-green-400";
    case "sent":
      return "text-blue-400";
    case "opened":
      return "text-purple-400";
    case "clicked":
      return "text-indigo-400";
    case "bounced":
      return "text-red-400";
    case "complained":
      return "text-orange-400";
    case "queued":
      return "text-neutral-400";
    default:
      return "text-neutral-500";
  }
}

export function getStatusDot(status: string) {
  switch (status) {
    case "delivered":
      return "bg-green-400";
    case "sent":
      return "bg-blue-400";
    case "opened":
      return "bg-purple-400";
    case "clicked":
      return "bg-indigo-400";
    case "bounced":
      return "bg-red-400";
    case "complained":
      return "bg-orange-400";
    case "queued":
      return "bg-neutral-400";
    default:
      return "bg-neutral-500";
  }
}

export function generateThreadId() {
  return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
