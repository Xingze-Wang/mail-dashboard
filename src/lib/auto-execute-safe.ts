// Shared "auto-execute these safe actions without user confirmation"
// helper. Used by BOTH the Lark agent (src/lib/lark-agent.ts) and the
// web help-bot endpoint (src/app/api/help/ask/route.ts) so behavior
// stays in lockstep: rep on Lark says "tell admin I'm stuck" → admin
// gets a Lark card. Rep on web says the same → admin gets the same
// Lark card. No surface-asymmetric behavior.
//
// What's "safe"? Pure DB-only writes with no Resend / no irreversible
// side-effects. Three current cases:
//   - remember_about_rep (write to helper_learnings)
//   - record_admin_request (write to admin_inbox + push Lark card)
//   - learn_from_admin_correction (admin-only, write to helper_learnings
//     with self_critique kind)
//
// Destructive actions (batch_send, send_lead_email, etc.) stay
// confirm-gated. Anything that hits Resend or flips lead status MUST
// require explicit user confirmation in /pipeline.

import { recordLearning } from "@/lib/helper-learnings";

interface ToolProposal {
  action: string;
  kind?: string;
  body?: string;
  headline?: string;
  scope?: string;
  source_rep_id?: number;
  evidence?: unknown;
  what_i_said?: string;
  correction?: string;
  sample_question?: string;
  [key: string]: unknown;
}

interface AutoExecSession {
  repId: number;
  role: string;
  repName?: string | null;
  email?: string | null;
}

/**
 * Try to auto-execute a safe proposal. Returns:
 *   - { executed: true, suffix }   — fired, append suffix to reply
 *   - { executed: false }          — not safe, caller does normal confirm flow
 */
export async function tryAutoExecuteSafe(
  session: AutoExecSession,
  proposal: ToolProposal,
): Promise<{ executed: true; suffix: string } | { executed: false }> {
  // ─── remember_about_rep ──────────────────────────────────────────────
  if (proposal.action === "remember_about_rep") {
    const kindRaw = typeof proposal.kind === "string" ? proposal.kind : "other";
    const allowed = ["rep_pref", "tactic", "self_critique", "other"] as const;
    type Kind = (typeof allowed)[number];
    const kind: Kind = (allowed as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : "other";
    const body = typeof proposal.body === "string" ? proposal.body.trim() : "";
    if (!body || body.length < 3 || body.length > 600) return { executed: false };
    const scope = proposal.scope === "org" && session.role === "admin" ? "org" : "rep";
    const scope_rep_id = scope === "org" ? null : session.repId;
    try {
      const learning = await recordLearning({
        scope_rep_id,
        kind,
        body,
        confidence: 0.8,
        evidence: { source: "auto_exec", session_rep: session.repId },
      });
      if (!learning) return { executed: false };
      return {
        executed: true,
        suffix: `\n\n— 记下来了 (kind: ${kind}): ${body.slice(0, 120)}${body.length > 120 ? "..." : ""}`,
      };
    } catch {
      return { executed: false };
    }
  }

  // ─── record_admin_request ────────────────────────────────────────────
  // Delegate to the existing read-tool dispatcher in helper-read-tools.ts
  // which already handles dedup + admin Lark-card push. Don't duplicate
  // the insert + card-send logic here.
  if (proposal.action === "record_admin_request") {
    const headline = typeof proposal.headline === "string" ? proposal.headline.trim().slice(0, 200) : "";
    const body = typeof proposal.body === "string" ? proposal.body.trim() : "";
    const kindRaw = typeof proposal.kind === "string" ? proposal.kind : "request";
    const kind = ["request", "observation", "idea"].includes(kindRaw) ? kindRaw : "request";
    if (!headline || headline.length < 5) return { executed: false };
    try {
      const { runReadTool } = await import("@/lib/helper-read-tools");
      const result = await runReadTool(
        {
          repId: session.repId,
          role: session.role,
          repName: session.repName ?? undefined,
          email: session.email ?? undefined,
        },
        {
          tool: "record_admin_request",
          args: {
            kind,
            headline,
            body: body || undefined,
            source_rep_id: typeof proposal.source_rep_id === "number" ? proposal.source_rep_id : session.repId,
            evidence: proposal.evidence ?? null,
          },
        },
      );
      const r = result?.result as { ok?: boolean; deduped?: boolean; error?: string } | undefined;
      if (!r?.ok) return { executed: false };
      return {
        executed: true,
        suffix: `\n\n— 已写入 admin inbox (kind: ${kind}): ${headline.slice(0, 100)}${headline.length > 100 ? "..." : ""}${r.deduped ? " · 同样的 headline 已存在, 更新了 body" : ""}. Admin 在 Lark 已收到卡片.`,
      };
    } catch {
      return { executed: false };
    }
  }

  // ─── learn_from_admin_correction ─────────────────────────────────────
  // Admin-only. Writes a self_critique learning that the next session's
  // prompt will see.
  if (proposal.action === "learn_from_admin_correction") {
    if (session.role !== "admin") return { executed: false };
    const what = typeof proposal.what_i_said === "string" ? proposal.what_i_said.trim().slice(0, 300) : "";
    const correction = typeof proposal.correction === "string" ? proposal.correction.trim().slice(0, 300) : "";
    if (!correction) return { executed: false };
    const scope = proposal.scope === "rep" ? "rep" : "org";
    const scope_rep_id = scope === "rep" ? session.repId : null;
    try {
      const learning = await recordLearning({
        scope_rep_id,
        kind: "self_critique",
        body: `Admin correction: ${correction}${what ? `\n\nI had said: ${what}` : ""}`,
        confidence: 0.9,
        evidence: {
          source: "auto_exec",
          admin_correction: true,
          sample_question: proposal.sample_question ?? null,
        },
      });
      if (!learning) return { executed: false };
      return {
        executed: true,
        suffix: `\n\n— 已 consolidate 进 self_critique (scope: ${scope}). 下次类似问题我会按这条新 memory 答.`,
      };
    } catch {
      return { executed: false };
    }
  }

  return { executed: false };
}
