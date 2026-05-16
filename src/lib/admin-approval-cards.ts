// Family of Lark admin-approval cards. Each card sends to admin's DM
// with one-tap buttons. The handler routes via value.<discriminator>
// (template_action / quota_action / congress_action), same pattern as
// admin_inbox_action in admin-inbox-card.ts.
//
// Card types:
//   - template_proposal_card: approve_draft / activate / reject (or
//     redirect to /templates/[id]/inspect for richer review)
//   - quota_bump_card: confirm / decline a proposed quota or trust_level
//     change Leon suggested ("Yujie wants 80/day", "trust_level +1")
//   - tactical_proposal_card: weekly Congress shipped a proposal —
//     accept / reject / open in dashboard for full deliberation context
//
// Why a shared module: same Lark JSON structure repeats with different
// titles + button labels. Centralizing the renderer + token + send
// path means one place to fix when Lark changes their card schema.

import { supabase } from "@/lib/db";
import { getTenantAccessToken, pickBase } from "@/lib/lark";

const ADMIN_REP_ID = 5;

async function getAdminOpenId(): Promise<string | null> {
  const { data } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", ADMIN_REP_ID)
    .maybeSingle();
  return (data?.lark_open_id as string | null) ?? null;
}

interface CardSendInput {
  receive_id: string;          // admin open_id
  card: object;
}

async function sendCard(input: CardSendInput): Promise<string | null> {
  const token = await getTenantAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${pickBase()}/im/v1/messages?receive_id_type=open_id`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          receive_id: input.receive_id,
          msg_type: "interactive",
          content: JSON.stringify(input.card),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const j = (await res.json().catch(() => ({}))) as { code?: number; data?: { message_id?: string } };
    if (res.ok && j.code === 0 && j.data?.message_id) return j.data.message_id;
    console.error("[admin-approval-cards] send failed:", res.status, j);
    return null;
  } catch (e) {
    console.error("[admin-approval-cards] exception:", e);
    return null;
  }
}

// ─── Template proposal card ─────────────────────────────────────────

/**
 * Push a card when a new template proposal lands (status='proposal').
 * Fired from /api/templates/fork after the row is inserted. Buttons:
 *   ✓ Approve draft (status → approved_draft)
 *   🚀 Activate now  (status → active)
 *   ❌ Reject         (prompts for reason via follow-up DM)
 *   🔎 Open inspect  (dashboard URL fallback for richer review)
 */
export async function sendTemplateProposalCard(args: {
  template_id: string;
  template_name: string;
  proposed_by: string | null;
  proposed_reason: string | null;
}): Promise<string | null> {
  // Guard: for rep-targeted proposals, the admin card MUST NOT fire
  // until the rep has approved. Org-wide proposals (rep_id = NULL)
  // skip this gate — admin is the only approver for those.
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("rep_id, rep_approved_at")
    .eq("id", args.template_id)
    .maybeSingle();
  if (tpl && tpl.rep_id != null && !tpl.rep_approved_at) {
    console.log(
      `[admin-approval-cards] template ${args.template_id} is rep-targeted (rep=${tpl.rep_id}) and rep hasn't approved yet — deferring admin card`,
    );
    return null;
  }
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) return null;

  const body = (args.proposed_reason ?? "(no reason provided)").slice(0, 1500);
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `📝 New template proposal` },
      template: "yellow",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            `**${args.template_name}**\n` +
            `_Proposed by: ${args.proposed_by ?? "(unknown)"}_\n\n${body}`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✓ Approve draft" },
            type: "primary",
            value: { template_action: "approve_draft", template_id: args.template_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🚀 Activate now" },
            type: "default",
            value: { template_action: "activate", template_id: args.template_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ Reject" },
            type: "danger",
            value: { template_action: "reject", template_id: args.template_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔎 Open inspect" },
            type: "default",
            url: `https://calistamind.com/templates/${args.template_id}/inspect`,
          },
        ],
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content:
            "Approve draft = sign off on the prose, doesn't ship to sends yet. Activate = ship to live sends (replaces the current active template for that segment). Reject = archive + capture reason as next-congress evidence.",
        }],
      },
    ],
  };
  return sendCard({ receive_id: adminOpenId, card });
}

// ─── Quota / trust_level proposal card ──────────────────────────────

/**
 * Push when Leon (via record_admin_request) wants to suggest a quota
 * bump for a rep. NOT auto-triggered — Leon decides when. Buttons:
 *   ✓ Apply
 *   📊 Open admin/missions  (for fine-grained control)
 *   🗑 Dismiss
 */
export async function sendQuotaProposalCard(args: {
  rep_id: number;
  rep_name: string;
  current_per_pool: Record<string, number>;
  proposed_per_pool: Record<string, number>;
  rationale: string;
  // unique key so re-suggestions for the same rep don't pile up
  proposal_key: string;
}): Promise<string | null> {
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) return null;

  const POOL_LABEL: Record<string, string> = {
    strong: "strong",
    normal_cn: ".cn",
    normal_overseas: "overseas",
    normal_edu: ".edu",
  };
  const renderPool = (pp: Record<string, number>) =>
    Object.entries(pp)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${POOL_LABEL[k] ?? k}=${v}`)
      .join(", ") || "(empty)";

  // Persist the proposed_per_pool so the click handler can read it
  // back. Buttons can carry up to ~1KB of value, but big jsonb is
  // unwieldy — we store it in a small `quota_proposals` row and only
  // pass the proposal_id in the button value.
  const { data: prop } = await supabase
    .from("admin_inbox")           // reuse admin_inbox as the storage table
    .insert({
      kind: "request",
      headline: `Quota bump for ${args.rep_name}`,
      body: `${args.rationale}\n\nCurrent: ${renderPool(args.current_per_pool)}\nProposed: ${renderPool(args.proposed_per_pool)}`,
      source_rep_id: args.rep_id,
      evidence: {
        kind: "quota_bump",
        rep_id: args.rep_id,
        current: args.current_per_pool,
        proposed: args.proposed_per_pool,
        proposal_key: args.proposal_key,
      },
      dedup_hash: args.proposal_key,
    })
    .select("id")
    .single();

  if (!prop) {
    console.error("[admin-approval-cards] failed to persist quota proposal");
    return null;
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `📊 Quota bump for ${args.rep_name}` },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            `**Rep**: ${args.rep_name} (rep_id=${args.rep_id})\n\n` +
            `**Current**: ${renderPool(args.current_per_pool)}\n` +
            `**Proposed**: ${renderPool(args.proposed_per_pool)}\n\n` +
            `**Why**: ${args.rationale.slice(0, 600)}`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✓ Apply" },
            type: "primary",
            value: { quota_action: "apply", proposal_id: prop.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "📊 Open admin/missions" },
            type: "default",
            url: "https://calistamind.com/admin/missions",
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🗑 Dismiss" },
            type: "danger",
            value: { quota_action: "dismiss", proposal_id: prop.id },
          },
        ],
      },
    ],
  };
  return sendCard({ receive_id: adminOpenId, card });
}

// ─── Tactical proposal card (Congress weekly output) ───────────────

/**
 * Push when runWeeklyCongress writes a tactical_proposals row.
 * Buttons:
 *   ✓ Accept
 *   ❌ Reject
 *   📂 Open dashboard  (richer view, dissent / replays)
 */
export async function sendTacticalProposalCard(args: {
  proposal_id: string;
  title: string;
  rationale: string;
}): Promise<string | null> {
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) return null;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🏛 Tactical proposal from Congress` },
      template: "purple",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${args.title}**\n\n${args.rationale.slice(0, 1500)}`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✓ Accept" },
            type: "primary",
            value: { congress_action: "accept", proposal_id: args.proposal_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ Reject" },
            type: "danger",
            value: { congress_action: "reject", proposal_id: args.proposal_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "📂 Open dashboard" },
            type: "default",
            url: `https://calistamind.com/congress/proposals/${args.proposal_id}`,
          },
        ],
      },
    ],
  };
  return sendCard({ receive_id: adminOpenId, card });
}

// ─── Card action handlers ──────────────────────────────────────────

async function adminGate(operatorOpenId: string): Promise<boolean> {
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("lark_open_id", operatorOpenId)
    .maybeSingle();
  return rep?.role === "admin";
}

export async function processTemplateCardAction(rawEvent: unknown): Promise<{ ok: boolean; reason?: string; toast?: string }> {
  const event = (rawEvent as { event?: unknown }).event ?? rawEvent;
  const ev = event as { operator?: { open_id?: string }; action?: { value?: { template_action?: string; template_id?: string } } };
  const op = ev.operator?.open_id;
  const action = ev.action?.value?.template_action;
  const tid = ev.action?.value?.template_id;
  if (!op || !action || !tid) return { ok: true, reason: "incomplete" };
  if (!(await adminGate(op))) return { ok: true, reason: "non-admin", toast: "Admin only." };

  // Template proposal endpoints already exist — we just dispatch
  // synthetically by calling the same supabase mutations they do.
  if (action === "approve_draft") {
    await supabase
      .from("email_templates")
      .update({ status: "approved_draft", updated_at: new Date().toISOString() })
      .eq("id", tid)
      .eq("status", "proposal");
    return { ok: true, reason: "approved_draft", toast: "✓ Approved as draft" };
  }
  if (action === "activate") {
    // Need to know segment_default — read first
    const { data: t } = await supabase
      .from("email_templates")
      .select("segment_default")
      .eq("id", tid)
      .maybeSingle();
    if (!t) return { ok: false, toast: "Template gone" };
    // Deactivate competitors in the same segment first
    if (t.segment_default) {
      await supabase
        .from("email_templates")
        .update({ active: false, status: "archived" })
        .eq("status", "active")
        .eq("segment_default", t.segment_default)
        .neq("id", tid);
    }
    await supabase
      .from("email_templates")
      .update({ status: "active", active: true, updated_at: new Date().toISOString() })
      .eq("id", tid);
    return { ok: true, reason: "activated", toast: "🚀 Activated live" };
  }
  if (action === "reject") {
    // Without an in-card text input we capture a placeholder reason and
    // ask admin via follow-up DM to elaborate. Mirrors the reject endpoint's
    // behavior; downstream congress evidence reads rejection_reason.
    await supabase
      .from("email_templates")
      .update({
        status: "archived",
        active: false,
        rejection_reason: "Rejected via Lark card (no reason given)",
        rejected_at: new Date().toISOString(),
      })
      .eq("id", tid);
    // Prompt for reason via DM
    const { sendMessage } = await import("@/lib/lark");
    await sendMessage({
      receive_id: op,
      receive_id_type: "open_id",
      text: `Rejected. To add a reason (becomes congress evidence), reply: \`template ${tid.slice(0, 8)} reason: <your reason>\``,
    });
    return { ok: true, reason: "rejected", toast: "❌ Rejected (reply with reason)" };
  }
  return { ok: true, reason: "unknown" };
}

export async function processQuotaCardAction(rawEvent: unknown): Promise<{ ok: boolean; reason?: string; toast?: string }> {
  const event = (rawEvent as { event?: unknown }).event ?? rawEvent;
  const ev = event as { operator?: { open_id?: string }; action?: { value?: { quota_action?: string; proposal_id?: string } } };
  const op = ev.operator?.open_id;
  const action = ev.action?.value?.quota_action;
  const pid = ev.action?.value?.proposal_id;
  if (!op || !action || !pid) return { ok: true, reason: "incomplete" };
  if (!(await adminGate(op))) return { ok: true, reason: "non-admin", toast: "Admin only." };

  const { data: prop } = await supabase
    .from("admin_inbox")
    .select("id, evidence, status")
    .eq("id", pid)
    .maybeSingle();
  if (!prop) return { ok: true, reason: "gone", toast: "Already gone" };
  if (prop.status === "done" || prop.status === "dismissed") return { ok: true, reason: "already decided", toast: `Already ${prop.status}` };

  if (action === "dismiss") {
    await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", acted_at: new Date().toISOString() })
      .eq("id", pid);
    return { ok: true, reason: "dismissed", toast: "🗑 Dismissed" };
  }

  if (action === "apply") {
    const ev2 = prop.evidence as { rep_id?: number; proposed?: Record<string, number> } | null;
    if (!ev2?.rep_id || !ev2?.proposed) {
      return { ok: false, toast: "Proposal data missing" };
    }
    // Upsert into rep_daily_quotas
    const { data: existing } = await supabase
      .from("rep_daily_quotas")
      .select("rep_id")
      .eq("rep_id", ev2.rep_id)
      .maybeSingle();
    if (existing) {
      await supabase
        .from("rep_daily_quotas")
        .update({ per_pool: ev2.proposed, updated_by_rep_id: ADMIN_REP_ID, updated_at: new Date().toISOString() })
        .eq("rep_id", ev2.rep_id);
    } else {
      await supabase
        .from("rep_daily_quotas")
        .insert({ rep_id: ev2.rep_id, per_pool: ev2.proposed, updated_by_rep_id: ADMIN_REP_ID });
    }
    await supabase
      .from("admin_inbox")
      .update({ status: "done", acted_at: new Date().toISOString() })
      .eq("id", pid);
    return { ok: true, reason: "applied", toast: "✓ Quota applied" };
  }
  return { ok: true, reason: "unknown" };
}

export async function processCongressCardAction(rawEvent: unknown): Promise<{ ok: boolean; reason?: string; toast?: string }> {
  const event = (rawEvent as { event?: unknown }).event ?? rawEvent;
  const ev = event as { operator?: { open_id?: string }; action?: { value?: { congress_action?: string; proposal_id?: string } } };
  const op = ev.operator?.open_id;
  const action = ev.action?.value?.congress_action;
  const pid = ev.action?.value?.proposal_id;
  if (!op || !action || !pid) return { ok: true, reason: "incomplete" };
  if (!(await adminGate(op))) return { ok: true, reason: "non-admin", toast: "Admin only." };

  // Schema uses ship_decision (pending|approved|rejected|superseded),
  // not a generic `status` column. See migration 039.
  if (action === "accept") {
    await supabase
      .from("tactical_proposals")
      .update({
        ship_decision: "approved",
        decided_at: new Date().toISOString(),
        decided_by: "lark-card",
      })
      .eq("id", pid);
    return { ok: true, reason: "accepted", toast: "✓ Accepted" };
  }
  if (action === "reject") {
    await supabase
      .from("tactical_proposals")
      .update({
        ship_decision: "rejected",
        decided_at: new Date().toISOString(),
        decided_by: "lark-card",
      })
      .eq("id", pid);
    return { ok: true, reason: "rejected", toast: "❌ Rejected" };
  }
  return { ok: true, reason: "unknown" };
}
