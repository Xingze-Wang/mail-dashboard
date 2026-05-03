import { PERSONA_META, type PersonaRole } from "@/lib/congress/types";

export function PersonaAvatar({ persona, size = "md" }: { persona: PersonaRole; size?: "sm" | "md" }) {
  const isAdversary = persona === "adversary";
  const dim = size === "sm" ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-[13px]";
  const color = isAdversary
    ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
    : "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-medium ${dim} ${color}`}
      aria-label={PERSONA_META[persona]?.label ?? persona}
    >
      {PERSONA_META[persona]?.initials ?? persona.slice(0, 2).toUpperCase()}
    </div>
  );
}
