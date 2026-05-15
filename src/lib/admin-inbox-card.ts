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

// Provenance labels — what generated this card?
// Pulled from evidence.source (or inferred from evidence fields).
const SOURCE_LABEL: Record<string, string> = {
  leon_uncertain: "🤔 Leon 不确定 (escalation)",
  leon_observation: "👀 Leon 自己注意到的",
  curriculum_miner: "📊 跨 rep 模式 (curriculum miner)",
  dynamic_tool_proposal: "🧰 Leon 想造工具",
  congress: "🏛 议事厅",
  rep_request: "🙋 Rep 直接 request",
  admin_self: "✍️ Admin 自己记的",
};

export function inferCardSource(evidence: Record<string, unknown> | null | undefined): {
  source: string;
  label: string;
} {
  const e = evidence ?? {};
  // Explicit source field wins
  if (typeof e.source === "string" && SOURCE_LABEL[e.source]) {
    return { source: e.source, label: SOURCE_LABEL[e.source] };
  }
  // Inferred sources from known evidence shapes
  if (typeof e.escalation_source === "string" || typeof e.my_best_guess === "string" || typeof e.why_unsure === "string") {
    return { source: "leon_uncertain", label: SOURCE_LABEL.leon_uncertain };
  }
  if (typeof e.dynamic_tool_id === "string") {
    return { source: "dynamic_tool_proposal", label: SOURCE_LABEL.dynamic_tool_proposal };
  }
  if (e.source === "curriculum_miner" || typeof e.medoid === "string") {
    return { source: "curriculum_miner", label: SOURCE_LABEL.curriculum_miner };
  }
  // Default: Leon's own observation (no explicit source recorded)
  return { source: "leon_observation", label: SOURCE_LABEL.leon_observation };
}

// All possible click actions encoded in card buttons.
// 'yes' / 'no' / 'expand_context' is the new unified set across all
// kinds. Old kind-specific actions (skill/memory/both/neither) are
// kept for backwards-compat with cards already in admin's DM.
export type AdminInboxAction =
  | "yes"
  | "no"
  | "expand_context"
  | "skill"
  | "memory"
  | "both"
  | "neither";

function buildButtonsForKind(_kind: string, inboxId: string) {
  // Unified 2-button card: Yes / No.
  // - Yes: Leon auto-classifies based on kind (request → ack; idea/obs →
  //   auto-decide skill/memory/both via LLM)
  // - No: status → 'awaiting_reason'; admin's next chat message in the
  //   DM is captured as rejected_reason and status flips to 'dismissed'
  //
  // For "more context" the admin can just DM Leon — e.g. "tell me more
  // about that idea card" — and Leon will pull the inbox row, sample
  // questions, similar existing learnings, etc. No third button needed.
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

function buildHelperNote(_kind: string) {
  return "Yes = 同意/有用 (idea/observation 会自动分类成 skill/memory). No = 不要 — Leon 会在 DM 里问你为什么, 你直接回一句, 系统会记下原因.";
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
  evidence?: Record<string, unknown> | null;  // for provenance inference
}): Promise<string | null> {
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) {
    console.error("[admin-inbox-card] admin has no lark_open_id, skipping card");
    return null;
  }

  const emoji = KIND_EMOJI[args.kind] ?? "📌";
  const kindLabel = KIND_LABEL[args.kind] ?? args.kind;

  // Build a two-line provenance footer: 来源 (what flow generated this)
  // + who (which rep, if any). Admin can tell at a glance whether to
  // trust this as "real demand" vs "Leon noticed something" vs noise.
  const { label: sourceLabel } = inferCardSource(args.evidence ?? null);
  const whoLine = args.source_rep_name
    ? `From: ${args.source_rep_name} (rep_id=${args.source_rep_id})`
    : args.source_rep_id != null
    ? `From: rep_id=${args.source_rep_id}`
    : "From: (no specific rep)";
  const sourceLine = `\n_${sourceLabel} · ${whoLine}_`;

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
    .select("id, kind, headline, body, status, source_rep_id, evidence")
    .eq("id", inboxId)
    .maybeSingle();
  if (!inbox) return { ok: true, reason: "inbox row gone", toast: "已经不在了" };
  if (inbox.status !== "new" && inbox.status !== "acknowledged") {
    return { ok: true, reason: `already decided: ${inbox.status}`, toast: `已是 ${inbox.status}` };
  }

  // Yes path: unified across all kinds. For kind=request just acknowledge
  // (+ trigger any side effect attached via evidence — e.g. approve a
  // dynamic_tool proposal). For kind=idea / kind=observation, auto-classify
  // the content into skill/memory/both via LLM and write helper_learnings
  // rows. Admin no longer has to pick the bucket — Leon decides.
  if (action === "yes") {
    const evidence = (inbox.evidence ?? {}) as Record<string, unknown>;
    let sideEffectToast: string | null = null;

    // Side effect: dynamic_tool proposal approved
    if (typeof evidence.dynamic_tool_id === "string") {
      const { approveDynamicTool } = await import("@/lib/dynamic-tools");
      const r = await approveDynamicTool({
        tool_id: evidence.dynamic_tool_id,
        approved_by_rep_id: rep.id,
        note: "approved via Lark card",
      });
      if (r.ok) sideEffectToast = `✅ tool '${evidence.dynamic_tool_name ?? ""}' approved`;
      else sideEffectToast = `⚠️ tool approve failed: ${r.error?.slice(0, 60) ?? ""}`;
    }

    // For idea/observation: auto-classify into skill vs memory vs both
    let classificationToast: string | null = null;
    if (inbox.kind === "idea" || inbox.kind === "observation") {
      const { classifyAndStoreLearning } = await import("@/lib/admin-inbox-classify");
      const r = await classifyAndStoreLearning({
        inbox_id: inboxId,
        headline: inbox.headline,
        body: inbox.body,
        original_kind: inbox.kind,
      });
      if (r.stored.length > 0) {
        const labels = r.stored.map((s) => s === "skill" ? "🛠 skill" : "💾 memory").join(" + ");
        classificationToast = `${labels} (Leon 自动分类)`;
      }
    }

    await supabase
      .from("admin_inbox")
      .update({
        status: inbox.kind === "request" ? "acknowledged" : "done",
        acted_at: new Date().toISOString(),
      })
      .eq("id", inboxId);
    return {
      ok: true,
      reason: "yes",
      toast: sideEffectToast ?? classificationToast ?? "✅ 同意",
    };
  }

  // No path: enter 'awaiting_reason'. Admin's next chat message gets
  // captured as rejected_reason. The capture happens in lark-agent.ts
  // (sees status=awaiting_reason on a recent inbox row for this admin
  // and absorbs the next inbound message as the reason).
  if (action === "no") {
    const evidence = (inbox.evidence ?? {}) as Record<string, unknown>;
    if (typeof evidence.dynamic_tool_id === "string") {
      const { rejectDynamicTool } = await import("@/lib/dynamic-tools");
      await rejectDynamicTool({
        tool_id: evidence.dynamic_tool_id,
        rejected_by_rep_id: rep.id,
        reason: "rejected via Lark card (reason pending)",
      });
    }
    await supabase
      .from("admin_inbox")
      .update({
        status: "awaiting_reason",
        awaiting_reason_since: new Date().toISOString(),
        acted_at: new Date().toISOString(),
      })
      .eq("id", inboxId);

    // DM admin asking for the reason
    try {
      const { getTenantAccessToken, pickBase } = await import("@/lib/lark");
      const token = await getTenantAccessToken();
      if (token && operatorOpenId) {
        await fetch(
          `${pickBase()}/im/v1/messages?receive_id_type=open_id`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              receive_id: operatorOpenId,
              msg_type: "text",
              content: JSON.stringify({
                text: `❌ 你点了 No 在 "${(inbox.headline ?? "").slice(0, 80)}". \n直接回一句**为什么** (1-2 句话就行), 我会记下来. 例如: "太杂, 我先看真实需求再说" / "这个 cluster 是假的, 两个 rep 在问不同的事" / "下周再说, 现在 priority 在 X".`,
              }),
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
      }
    } catch (err) {
      console.warn("[admin-inbox-card] follow-up DM failed:", err);
    }
    return { ok: true, reason: "no", toast: "❌ 已 No — 等你说原因" };
  }

  // Backwards-compat: the 'expand_context' action used by the previous
  // 3-button card is no longer wired (the 2-button card doesn't surface
  // it). If a legacy card still has the button, just return a hint.
  if (action === "expand_context") {
    return {
      ok: true,
      reason: "expand_context_legacy",
      toast: "在 DM 里跟我说 'more context' 我帮你拉",
    };
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
