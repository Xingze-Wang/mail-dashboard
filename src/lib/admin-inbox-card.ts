// Lark interactive card for admin_inbox items.
//
// Buttons branch on inbox.kind:
//   - kind=request  → [✅ Yes] [❌ No]                   (a TODO Leon needs go-ahead on)
//   - kind=observation|idea → [Skill] [Memory] [Both] [Neither]   (a learning to triage)
//
// "Yes" on a request = ack + (optional follow-up later);
// "No" = dismiss. Yes/No is binary because requests are go/no-go.
//
// Skill / Memory / Both / Neither on observations + ideas:
//   - Skill   = procedure Leon should activate in the right context
//               (loaded every session — small budget, must be high-signal)
//   - Memory  = qualitative fact, loaded by relevance (FTS, future work)
//   - Both    = activatable AND worth recalling — promote into both kinds
//   - Neither = noise, don't keep
//
// The dispatcher lives in lark-bot-worker + /api/lark/webhook; it routes
// `value.admin_inbox_action` into processAdminInboxCardAction below.

import { supabase } from "@/lib/db";
import { getTenantAccessToken, pickBase } from "@/lib/lark";

const ADMIN_REP_ID = 5;  // Xingze, kept consistent with onboarding.ts

async function getAdminOpenId(): Promise<string | null> {
  const { data } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", ADMIN_REP_ID)
    .maybeSingle();
  return (data?.lark_open_id as string | null) ?? null;
}

const KIND_EMOJI: Record<string, string> = {
  request: "🛠",
  observation: "👁",
  idea: "💡",
};

const KIND_LABEL: Record<string, string> = {
  request: "Request",
  observation: "Observation",
  idea: "Idea",
};

// All possible click actions encoded in card buttons.
export type AdminInboxAction = "yes" | "no" | "skill" | "memory" | "both" | "neither";

function buildButtonsForKind(kind: string, inboxId: string) {
  const isRequest = kind === "request";
  if (isRequest) {
    return [
      {
        tag: "button",
        text: { tag: "plain_text", content: "✅ Yes" },
        type: "primary",
        value: { admin_inbox_action: "yes", inbox_id: inboxId },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "❌ No" },
        type: "danger",
        value: { admin_inbox_action: "no", inbox_id: inboxId },
      },
    ];
  }
  // observation / idea (or anything else) → Skill / Memory / Both / Neither
  return [
    {
      tag: "button",
      text: { tag: "plain_text", content: "🛠 Skill" },
      type: "primary",
      value: { admin_inbox_action: "skill", inbox_id: inboxId },
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "💾 Memory" },
      type: "default",
      value: { admin_inbox_action: "memory", inbox_id: inboxId },
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "⚡ Both" },
      type: "default",
      value: { admin_inbox_action: "both", inbox_id: inboxId },
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "🗑 Neither" },
      type: "danger",
      value: { admin_inbox_action: "neither", inbox_id: inboxId },
    },
  ];
}

function buildHelperNote(kind: string) {
  if (kind === "request") {
    return "Yes = 同意/已处理. No = 不做/不相关.";
  }
  return "Skill = 我下次该这么做 (always loaded). Memory = 记住这个事实 (relevance-loaded). Both = 两个都存. Neither = 噪音, 不留.";
}

/**
 * Push an interactive card to admin's Lark DM.
 */
export async function sendAdminInboxCard(args: {
  inbox_id: string;
  kind: string;
  headline: string;
  body: string | null;
  source_rep_id: number | null;
  source_rep_name?: string | null;
}): Promise<string | null> {
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) {
    console.error("[admin-inbox-card] admin has no lark_open_id, skipping card");
    return null;
  }

  const emoji = KIND_EMOJI[args.kind] ?? "📌";
  const kindLabel = KIND_LABEL[args.kind] ?? args.kind;
  const sourceLine = args.source_rep_name
    ? `\n_From: ${args.source_rep_name} (rep_id=${args.source_rep_id})_`
    : args.source_rep_id != null
    ? `\n_From: rep_id=${args.source_rep_id}_`
    : "";

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `${emoji} ${kindLabel} from Leon` },
      template: args.kind === "request" ? "orange" : args.kind === "observation" ? "blue" : "purple",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${args.headline}**${sourceLine}${args.body ? `\n\n${args.body.slice(0, 1500)}` : ""}`,
        },
      },
      {
        tag: "action",
        actions: buildButtonsForKind(args.kind, args.inbox_id),
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: buildHelperNote(args.kind),
        }],
      },
    ],
  };

  try {
    const token = await getTenantAccessToken();
    if (!token) return null;
    const res = await fetch(
      `${pickBase()}/im/v1/messages?receive_id_type=open_id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: adminOpenId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const j = (await res.json().catch(() => ({}))) as { code?: number; data?: { message_id?: string } };
    if (res.ok && j.code === 0 && j.data?.message_id) {
      return j.data.message_id;
    }
    console.error("[admin-inbox-card] send failed:", res.status, j);
    return null;
  } catch (e) {
    console.error("[admin-inbox-card] exception:", e);
    return null;
  }
}

/**
 * Handle a click on the admin_inbox card.
 *
 * Action semantics:
 *   yes      → mark inbox.status='acknowledged' (request approved/handled)
 *   no       → mark inbox.status='dismissed'
 *   skill    → recordLearning(kind='skill') + inbox done
 *   memory   → recordLearning(kind='tactic' or 'self_critique', depending on inbox.kind)
 *   both     → write two learnings (skill + memory)
 *   neither  → inbox.status='dismissed'
 */
export async function processAdminInboxCardAction(rawEvent: unknown): Promise<{
  ok: boolean;
  reason?: string;
  toast?: string;
}> {
  const env = rawEvent as { event?: unknown };
  const event = (env.event ?? rawEvent) as {
    operator?: { open_id?: string };
    action?: {
      value?: {
        admin_inbox_action?: AdminInboxAction;
        inbox_id?: string;
      };
    };
  };
  const operatorOpenId = event.operator?.open_id;
  const action = event.action?.value?.admin_inbox_action;
  const inboxId = event.action?.value?.inbox_id;
  if (!operatorOpenId || !action || !inboxId) {
    return { ok: true, reason: "incomplete card action" };
  }

  const { data: rep } = await supabase
    .from("sales_reps")
    .select("id, role")
    .eq("lark_open_id", operatorOpenId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") {
    return { ok: true, reason: "non-admin click on admin-only card", toast: "Admin only." };
  }

  const { data: inbox } = await supabase
    .from("admin_inbox")
    .select("id, kind, headline, body, status, source_rep_id")
    .eq("id", inboxId)
    .maybeSingle();
  if (!inbox) return { ok: true, reason: "inbox row gone", toast: "已经不在了" };
  if (inbox.status !== "new" && inbox.status !== "acknowledged") {
    return { ok: true, reason: `already decided: ${inbox.status}`, toast: `已是 ${inbox.status}` };
  }

  // Yes/No path (kind=request)
  if (action === "yes") {
    await supabase
      .from("admin_inbox")
      .update({ status: "acknowledged", acted_at: new Date().toISOString() })
      .eq("id", inboxId);
    return { ok: true, reason: "yes", toast: "✅ 同意" };
  }
  if (action === "no") {
    await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", acted_at: new Date().toISOString() })
      .eq("id", inboxId);
    return { ok: true, reason: "no", toast: "❌ 不做" };
  }

  // Skill / Memory / Both / Neither path (kind=observation | idea)
  if (action === "neither") {
    await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", acted_at: new Date().toISOString() })
      .eq("id", inboxId);
    return { ok: true, reason: "neither", toast: "🗑 不留" };
  }

  // For skill / memory / both — promote to helper_learnings.
  // "memory" body is the user-written headline + body; we keep the
  // memory-style kind ('tactic' for ideas, 'self_critique' for observations).
  const body =
    (inbox.body && inbox.body.length >= 10 ? inbox.body : null) ||
    inbox.headline;
  const trimmed = String(body).slice(0, 600);
  const memoryKind: "tactic" | "self_critique" =
    inbox.kind === "idea" ? "tactic" : "self_critique";

  const { recordLearning } = await import("@/lib/helper-learnings");

  const learningIds: string[] = [];
  if (action === "skill" || action === "both") {
    const skillRow = await recordLearning({
      scope_rep_id: null,
      kind: "skill",
      body: trimmed,
      confidence: 0.95,
      evidence: {
        source: "admin_inbox_card",
        promoted_from_inbox: inboxId,
        original_kind: inbox.kind,
        decision: action,
        at: new Date().toISOString(),
      },
    });
    if (skillRow) learningIds.push(skillRow.id);
  }
  if (action === "memory" || action === "both") {
    const memRow = await recordLearning({
      scope_rep_id: null,
      kind: memoryKind,
      body: trimmed,
      confidence: 0.9,
      evidence: {
        source: "admin_inbox_card",
        promoted_from_inbox: inboxId,
        original_kind: inbox.kind,
        decision: action,
        at: new Date().toISOString(),
      },
    });
    if (memRow) learningIds.push(memRow.id);
  }

  if (learningIds.length === 0) {
    return { ok: false, reason: "recordLearning failed", toast: "存失败, 看 server log" };
  }

  await supabase
    .from("admin_inbox")
    .update({
      status: "done",
      acted_at: new Date().toISOString(),
      evidence: {
        promoted_to_learning_ids: learningIds,
        decision: action,
      },
    })
    .eq("id", inboxId);

  const toastMap: Record<string, string> = {
    skill: "🛠 存为 skill (每次会激活)",
    memory: "💾 存为 memory (相关时召回)",
    both: "⚡ Skill + Memory 都存了",
  };
  return { ok: true, reason: action, toast: toastMap[action] ?? "ok" };
}
