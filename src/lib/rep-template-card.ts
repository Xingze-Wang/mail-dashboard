// src/lib/rep-template-card.ts
//
// Rep-side approval card for the auto-template propose-to-rep flow
// (docs/superpowers/plans/2026-05-16-auto-template-propose-to-rep.md).
//
// Mirrors src/lib/admin-approval-cards.ts but the receive_id is the
// rep's lark_open_id, not the admin's. The dispatcher discriminator is
// `template_rep_action` (not `template_action`) so the webhook routes
// rep-side clicks to a different handler that ONLY flips
// rep_approved_at — admin still has to sign off on the second card.

import { supabase } from "@/lib/db";
import { getTenantAccessToken, pickBase } from "@/lib/lark";

function isSmokeNoCards(): boolean {
  return process.env.SMOKE_NO_CARDS === "1";
}

async function getRepOpenId(repId: number): Promise<string | null> {
  const { data } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", repId)
    .maybeSingle();
  return (data?.lark_open_id as string | null) ?? null;
}

export interface SendArgs {
  template_id: string;
  template_name: string;
  rep_id: number;
  proposed_reason: string;
  diff_summary: string;
}

/**
 * DM the rep a card showing the proposed template + diff vs their
 * current effective template. Returns the Lark message_id (so the
 * cron can store it for later card-rewrite on approve/reject), or null
 * on smoke / send-failure.
 */
export async function sendRepTemplateProposalCard(args: SendArgs): Promise<string | null> {
  if (isSmokeNoCards()) {
    console.log("[rep-template-card] SMOKE_NO_CARDS=1 — skip Lark push for template", args.template_id);
    return null;
  }
  const openId = await getRepOpenId(args.rep_id);
  if (!openId) {
    console.error(`[rep-template-card] rep ${args.rep_id} has no lark_open_id, skipping`);
    return null;
  }
  const token = await getTenantAccessToken();
  if (!token) return null;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🎯 你的编辑模式 → 模板提案" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${args.template_name}**\n\n_${args.proposed_reason}_\n\n**Diff:**\n${args.diff_summary}\n\n点 ✓ 就送给 admin approve. 不对就 ✏️ (我会跟你聊聊改) 或 ❌.`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✓ 同意" },
            type: "primary",
            value: { template_rep_action: "approve", template_id: args.template_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "✏️ 让我改" },
            value: { template_rep_action: "revise", template_id: args.template_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ 不要" },
            type: "danger",
            value: { template_rep_action: "reject", template_id: args.template_id },
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as { code?: number; data?: { message_id?: string } };
    if (res.ok && j.code === 0 && j.data?.message_id) return j.data.message_id;
    console.error("[rep-template-card] send failed:", res.status, j);
    return null;
  } catch (e) {
    console.error("[rep-template-card] send threw:", String(e).slice(0, 200));
    return null;
  }
}
