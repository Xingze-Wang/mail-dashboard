// skill-demo-suggester — when a new skill lands in helper_learnings,
// decide whether to suggest a smoke-test run.
//
// Two questions:
//   1. Should this skill be demo'd?  (some skills are pure rules with
//      no demonstrable side effect — those don't get demos)
//   2. If yes, what's a good test query?
//
// Heuristic-first: regex for action words ("调", "lookup", "调 tool",
// "use X tool", "run", "执行"). LLM fallback only on ambiguous.
//
// Output: pushes an admin_inbox card (kind=idea) with the suggested
// test query. Admin Yes → Leon runs the test query as if a rep had
// asked it, captures the response, DMs admin the result.

import { supabase } from "@/lib/db";

// Chinese has no \b word boundaries — anchor by char-class boundaries
// instead. English uses \b for "lookup", "use", etc.
const ACTION_PATTERNS = [
  /(调用|调\s+|使用|执行|跑\s+)\s*([a-z_][a-z_0-9]*)/i,
  /\b(lookup|use|run|fire|call|invoke)\s+([a-z_][a-z_0-9]*)/i,
  /(应该|必须|下次)[^。]{0,30}(调|lookup|用|执行)/,
];

export function shouldSuggestDemo(skillBody: string, triggers: string[] = []): boolean {
  if (!skillBody || skillBody.length < 10) return false;
  // Has at least one trigger AND mentions an action verb
  const hasAction = ACTION_PATTERNS.some((p) => p.test(skillBody));
  const hasTrigger = triggers && triggers.length > 0;
  return hasAction && hasTrigger;
}

/**
 * Pick a sample query that would activate this skill. Cheap: pick the
 * first trigger + wrap in a natural-language frame.
 */
export function craftDemoQuery(skillBody: string, triggers: string[]): string {
  const t = triggers[0] ?? "the topic";
  // If trigger looks like a Chinese phrase, frame in zh; else en.
  if (/[一-鿿]/.test(t)) {
    return `rep 问关于 ${t} 的问题, 你怎么答?`;
  }
  return `A rep asks about "${t}". How would you respond?`;
}

/** Push an admin_inbox card suggesting a demo for the new skill. */
export async function suggestDemoForNewSkill(args: {
  learning_id: string;
  body: string;
  triggers: string[];
  proposed_by_rep_id?: number | null;
}): Promise<{ pushed: boolean; inbox_id?: string }> {
  if (!shouldSuggestDemo(args.body, args.triggers)) return { pushed: false };

  const sampleQuery = craftDemoQuery(args.body, args.triggers);
  const headline = `🧪 新 skill 想 demo 一下吗? — ${args.body.slice(0, 80)}`.slice(0, 200);
  const body = [
    `**新存的 skill:**\n${args.body}`,
    `**Triggers:** ${args.triggers.join(", ")}`,
    "",
    `**建议测试 query:** "${sampleQuery}"`,
    "",
    "Yes → 我用这条 query 跑一遍, 把响应贴给你看. No → 跳过 demo.",
  ].join("\n");

  const enc = new TextEncoder();
  const key = `skill_demo|${args.learning_id}`;
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
  const dedupHash = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { data: inbox } = await supabase
    .from("admin_inbox")
    .insert({
      kind: "idea",
      headline,
      body,
      source_rep_id: args.proposed_by_rep_id ?? null,
      evidence: {
        source: "skill_demo_suggestion",
        learning_id: args.learning_id,
        sample_query: sampleQuery,
        skill_triggers: args.triggers,
      },
      dedup_hash: dedupHash,
    })
    .select("id")
    .single();
  if (!inbox) return { pushed: false };

  try {
    const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
    await sendAdminInboxCard({
      inbox_id: inbox.id,
      kind: "idea",
      headline,
      body,
      source_rep_id: args.proposed_by_rep_id ?? null,
      evidence: { source: "skill_demo_suggestion", learning_id: args.learning_id, sample_query: sampleQuery },
    });
  } catch (err) {
    console.warn("[skill-demo-suggester] card push failed:", err);
  }

  return { pushed: true, inbox_id: inbox.id };
}
