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

/**
 * Rewrite a sent Lark card in place so the buttons are replaced by a
 * single "resolved" line. This is what makes a click feel real —
 * without this, the original card stays clickable forever and admin
 * can't tell their click took effect.
 *
 * Best-effort: a failed PATCH means the card just stays as-is; the
 * DB side effect already ran, so the user-visible bug is "card looks
 * stale" not "click didn't work".
 */
async function rewriteCardToResolved(messageId: string, resolutionLine: string): Promise<void> {
  try {
    const token = await getTenantAccessToken();
    if (!token) return;
    const newCard = {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: "div",
          text: { tag: "lark_md", content: resolutionLine },
        },
      ],
    };
    const res = await fetch(
      `${pickBase()}/im/v1/messages/${messageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: JSON.stringify(newCard) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("[admin-inbox-card] PATCH failed:", res.status, txt.slice(0, 200));
    }
  } catch (err) {
    console.warn("[admin-inbox-card] rewriteCardToResolved exception:", err);
  }
}

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
/**
 * Test-mode escape hatch: set SMOKE_NO_CARDS=1 in env to skip the actual
 * Lark push while still letting the rest of the code path run. Smoke
 * tests should set this so they don't pollute admin's real DM with
 * cards backed by rows that get deleted on cleanup.
 */
function isSmokeNoCards(): boolean {
  return process.env.SMOKE_NO_CARDS === "1";
}

export async function sendAdminInboxCard(args: {
  inbox_id: string;
  kind: string;
  headline: string;
  body: string | null;
  source_rep_id: number | null;
  source_rep_name?: string | null;
  evidence?: Record<string, unknown> | null;  // for provenance inference
}): Promise<string | null> {
  if (isSmokeNoCards()) {
    console.log("[admin-inbox-card] SMOKE_NO_CARDS=1 — skipping Lark push for inbox", args.inbox_id);
    return null;
  }
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
      // Persist message_id so processAdminInboxCardAction can rewrite
      // this exact card to a "✅ Done — <action>" body after admin clicks.
      // Without this, the original card stays clickable forever, which is
      // why admin can't tell their click took effect (P0 friction).
      try {
        const { data: existing } = await supabase
          .from("admin_inbox")
          .select("evidence")
          .eq("id", args.inbox_id)
          .maybeSingle();
        const ev = (existing?.evidence ?? {}) as Record<string, unknown>;
        ev.card_message_id = j.data.message_id;
        await supabase.from("admin_inbox").update({ evidence: ev }).eq("id", args.inbox_id);
      } catch {/* best-effort: card already pushed, evidence patch is non-critical */}
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
  if (!inbox) {
    // Row was deleted (e.g. by a smoke-test cleanup). Tell admin
    // explicitly so they don't think their click did nothing.
    try {
      const { getTenantAccessToken, pickBase } = await import("@/lib/lark");
      const token = await getTenantAccessToken();
      if (token && operatorOpenId) {
        await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            receive_id: operatorOpenId,
            msg_type: "text",
            content: JSON.stringify({
              text: `⚠️ 你点的那张卡的 inbox 行已经不在数据库里了 (可能是 smoke test 清掉的). 你的点击没有副作用. 如果还想 follow up, 直接跟我说.`,
            }),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch {/* best-effort */}
    return { ok: true, reason: "inbox row gone", toast: "⚠️ 这张卡已被清理 (smoke test)" };
  }
  if (inbox.status !== "new" && inbox.status !== "acknowledged") {
    try {
      const { getTenantAccessToken, pickBase } = await import("@/lib/lark");
      const token = await getTenantAccessToken();
      if (token && operatorOpenId) {
        await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            receive_id: operatorOpenId,
            msg_type: "text",
            content: JSON.stringify({
              text: `⚠️ 你点的卡之前已经 ${inbox.status === "dismissed" ? "被 dismiss" : inbox.status === "done" ? "处理完" : "标记为 " + inbox.status} 了 — 这次点击没有再次生效. 那条卡是: "${(inbox.headline ?? "").slice(0, 80)}"`,
            }),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch {/* best-effort */}
    return { ok: true, reason: `already decided: ${inbox.status}`, toast: `⚠️ 这张已是 ${inbox.status}` };
  }

  // Pull the stored card message_id (sent by sendAdminInboxCard) so we
  // can patch the card to a resolved state at the end of each branch.
  const cardMessageId =
    (inbox.evidence as Record<string, unknown> | null)?.card_message_id as string | undefined;
  const headlineShort = (inbox.headline ?? "").slice(0, 100);

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

    // Side effect: skill demo suggestion approved → fire DM with the
    // sample query to admin so they can paste it into the Lark bot
    // surface (or any other surface) and observe Leon's behavior.
    // We don't auto-execute via the LLM here — that would require
    // spinning a full agent session in cron context which is expensive.
    // Pasting is the right friction level: admin sees the demo run
    // happen in real time.
    if (evidence.source === "skill_demo_suggestion" && typeof evidence.sample_query === "string") {
      sideEffectToast = `🧪 Demo query: paste it into Lark to see the skill activate`;
      try {
        const { getTenantAccessToken, pickBase } = await import("@/lib/lark");
        const token = await getTenantAccessToken();
        if (token && operatorOpenId) {
          await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              receive_id: operatorOpenId,
              msg_type: "text",
              content: JSON.stringify({
                text: `🧪 **Skill demo** — 把这条贴回来给我, 我跑给你看:\n\n${evidence.sample_query}\n\n_(贴完我用刚 promote 的 skill 答, 你看是否对.)_`,
              }),
            }),
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch (err) {
        console.warn("[admin-inbox-card] demo DM failed:", err);
      }
    }

    // Side effect: congress debate topic approved → flag for next Monday
    if (typeof evidence.congress_debate_id === "string") {
      const { error: upErr } = await supabase
        .from("congress_debate_proposals")
        .update({
          status: "approved",
          approved_by_rep_id: rep.id,
          approved_at: new Date().toISOString(),
        })
        .eq("id", evidence.congress_debate_id);
      sideEffectToast = upErr
        ? `⚠️ congress topic approval failed: ${upErr.message.slice(0, 60)}`
        : "🏛 已批准 — 周一 Congress 会讨论";
    }

    // Side effect: guided_task plan approved → flip to running
    if (typeof evidence.guided_task_id === "string") {
      const { approveGuidedTaskPlan } = await import("@/lib/guided-tasks");
      const r = await approveGuidedTaskPlan({
        task_id: evidence.guided_task_id,
        approved_by_rep_id: rep.id,
      });
      if (r.ok) {
        sideEffectToast = `🚀 多步任务开始执行 (${r.task?.steps.length ?? "?"} 步)`;
      } else {
        sideEffectToast = `⚠️ 启动失败: ${r.error?.slice(0, 80) ?? ""}`;
      }
    }

    // Side effect: dynamic_write proposal approved + executed
    if (typeof evidence.dynamic_write_id === "string") {
      const { applyDynamicWrite } = await import("@/lib/dynamic-writes");
      const r = await applyDynamicWrite({
        write_id: evidence.dynamic_write_id,
        approved_by_rep_id: rep.id,
      });
      if (r.ok) {
        sideEffectToast = `✅ DB write executed (${r.rows_affected ?? "?"} 行)`;
      } else {
        sideEffectToast = `⚠️ DB write failed: ${r.error?.slice(0, 80) ?? "unknown"}`;
      }
    }

    // For idea/observation: auto-classify into skill vs memory vs both.
    // EXCEPT if this is a Leon-self-skill-proposal — those already
    // come with the skill body + triggers, no need to re-classify.
    let classificationToast: string | null = null;
    if (inbox.kind === "idea" || inbox.kind === "observation") {
      if (evidence.source === "leon_self_skill_proposal" && typeof evidence.proposed_skill_body === "string") {
        // Direct path: Leon proposed an explicit skill. Trust it.
        const { recordLearning } = await import("@/lib/helper-learnings");
        const skill = await recordLearning({
          scope_rep_id: null,
          kind: "skill",
          body: String(evidence.proposed_skill_body).slice(0, 600),
          confidence: 0.85,
          triggers: Array.isArray(evidence.proposed_triggers) ? (evidence.proposed_triggers as string[]).slice(0, 6) : [],
          evidence: {
            source: "leon_self_skill_proposal_approved",
            promoted_from_inbox: inboxId,
            reasoning: evidence.reasoning ?? null,
            at: new Date().toISOString(),
          },
        });
        if (skill) {
          classificationToast = `🧠 Leon 的自加 skill 已激活`;
        }
      } else {
        // Normal path: LLM auto-classifies admin-curated insights
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
    }

    await supabase
      .from("admin_inbox")
      .update({
        status: inbox.kind === "request" ? "acknowledged" : "done",
        acted_at: new Date().toISOString(),
      })
      .eq("id", inboxId);

    // Rewrite the card so buttons disappear and admin sees what happened.
    if (cardMessageId) {
      const resolutionLine = sideEffectToast ?? classificationToast ?? "✅ 已同意";
      await rewriteCardToResolved(
        cardMessageId,
        `✅ **${resolutionLine}**\n_${headlineShort}_`,
      );
    }
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
    if (typeof evidence.dynamic_write_id === "string") {
      const { rejectDynamicWrite } = await import("@/lib/dynamic-writes");
      await rejectDynamicWrite({
        write_id: evidence.dynamic_write_id,
        rejected_by_rep_id: rep.id,
        reason: "rejected via Lark card (reason pending)",
      });
    }
    if (typeof evidence.congress_debate_id === "string") {
      await supabase.from("congress_debate_proposals").update({
        status: "rejected",
        approved_by_rep_id: rep.id,
        approved_at: new Date().toISOString(),
        rejected_reason: "rejected via Lark card (reason pending)",
      }).eq("id", evidence.congress_debate_id);
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
    if (cardMessageId) {
      await rewriteCardToResolved(
        cardMessageId,
        `❌ **已 No** — 等你在 DM 里说原因\n_${headlineShort}_`,
      );
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
    if (cardMessageId) {
      await rewriteCardToResolved(cardMessageId, `🗑 **不留**\n_${headlineShort}_`);
    }
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
  const resolved = toastMap[action] ?? "ok";
  if (cardMessageId) {
    await rewriteCardToResolved(cardMessageId, `✅ **${resolved}**\n_${headlineShort}_`);
  }
  return { ok: true, reason: action, toast: resolved };
}
