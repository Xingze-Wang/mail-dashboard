// Lark interactive card for admin_inbox items.
//
// Use case: every time Leon writes a `record_admin_request` (kind = request /
// observation / idea), instead of (or in addition to) just letting it pile up
// in the dashboard inbox, push a Lark card to admin's DM with three buttons:
//
//   [✓ Acknowledged]   — mark status='acknowledged' (admin saw it, not actioned)
//   [💾 Save as memory] — promote to helper_learnings (kind=self_critique or
//                         tactic, scope=org-wide) so Leon learns from it
//   [🗑 Dismiss]        — mark status='dismissed' (not actionable / noise)
//
// The card-action callback is dispatched in the existing /api/lark/webhook
// + lark-bot-worker, alongside onboarding_action and jitr_action; we
// discriminate via `value.admin_inbox_action`.
//
// Why a card vs the dashboard inbox: admin already lives in Lark; opening
// /admin/inbox to triage a single ping is too much friction. One-click
// triage from where the notification arrives is the OpenClaw-style UX
// the user asked for.

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

/**
 * Push an interactive card to admin's Lark DM. Called from the
 * record_admin_request flow right after the admin_inbox row is
 * inserted. Returns the message_id if the push succeeded.
 *
 * Best-effort: a failed push doesn't break record_admin_request —
 * the row still exists in the dashboard inbox. We just lose the
 * one-tap convenience.
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
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✓ Acknowledged" },
            type: "primary",
            value: { admin_inbox_action: "acknowledge", inbox_id: args.inbox_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "💾 Save as memory" },
            type: "default",
            value: { admin_inbox_action: "save_as_memory", inbox_id: args.inbox_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🗑 Dismiss" },
            type: "danger",
            value: { admin_inbox_action: "dismiss", inbox_id: args.inbox_id },
          },
        ],
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content:
            "Acknowledged = 'I saw it, not actioned'. Save as memory = promote into Leon's long-term self_critique so this doesn't repeat. Dismiss = noise, don't ping again.",
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
 * Handle a click on the [Acknowledged / Save as memory / Dismiss]
 * buttons. Called from the card-action dispatcher in lark-bot-worker
 * + /api/lark/webhook when value.admin_inbox_action is present.
 *
 * Returns toast content so the webhook can ack the click with a
 * Lark-shaped {toast: {type, content}} response.
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
        admin_inbox_action?: "acknowledge" | "save_as_memory" | "dismiss";
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

  // Admin-only — same gate as the onboarding card.
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

  if (action === "acknowledge") {
    await supabase
      .from("admin_inbox")
      .update({ status: "acknowledged", acted_at: new Date().toISOString() })
      .eq("id", inboxId);
    return { ok: true, reason: "acknowledged", toast: "已 ack" };
  }

  if (action === "dismiss") {
    await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", acted_at: new Date().toISOString() })
      .eq("id", inboxId);
    return { ok: true, reason: "dismissed", toast: "已 dismiss" };
  }

  if (action === "save_as_memory") {
    // Promote the inbox row to a self_critique memory + mark inbox done.
    // Tactic-vs-self_critique heuristic: 'observation' / 'idea' tend to
    // be tactical learnings; 'request' is an admin TODO and shouldn't
    // become memory by itself. We default to self_critique because the
    // user can refine via the dashboard if needed.
    const kind: "tactic" | "self_critique" =
      inbox.kind === "idea" ? "tactic" : "self_critique";
    const body =
      (inbox.body && inbox.body.length >= 10 ? inbox.body : null) ||
      inbox.headline;
    const { recordLearning } = await import("@/lib/helper-learnings");
    const learning = await recordLearning({
      scope_rep_id: null, // org-wide; if it was rep-specific they can scope later
      kind,
      body: String(body).slice(0, 600),
      confidence: 0.9,
      evidence: {
        source: "admin_inbox_card",
        promoted_from_inbox: inboxId,
        original_kind: inbox.kind,
        at: new Date().toISOString(),
      },
    });
    if (!learning) {
      return { ok: false, reason: "recordLearning failed", toast: "存 memory 失败, 看 server log" };
    }
    await supabase
      .from("admin_inbox")
      .update({
        status: "done",
        acted_at: new Date().toISOString(),
        // Stash the learning_id in evidence so dashboard can show the link
        evidence: {
          ...(typeof inbox.body === "object" ? {} : {}),
          promoted_to_learning_id: learning.id,
        },
      })
      .eq("id", inboxId);
    return { ok: true, reason: "promoted_to_memory", toast: `已存入长期记忆 (${kind})` };
  }

  return { ok: true, reason: "unknown action" };
}
