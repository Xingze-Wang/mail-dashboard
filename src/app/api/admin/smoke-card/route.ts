import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  sendTemplateProposalCard,
  sendQuotaProposalCard,
  sendTacticalProposalCard,
} from "@/lib/admin-approval-cards";

export const runtime = "nodejs";

/**
 * GET /api/admin/smoke-card?kind=template|quota|congress
 *
 * Admin-only smoke endpoint that fires a real approval card to the
 * configured admin DM (rep_id=5). Useful for verifying the wiring end
 * to end without needing to actually fork a template or create a
 * proposal. The cards are safe to click — they operate on synthetic IDs
 * and the handlers update 0 rows.
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const kind = new URL(req.url).searchParams.get("kind") ?? "template";

  if (kind === "template") {
    const id = await sendTemplateProposalCard({
      template_id: "00000000-0000-0000-0000-000000000000",
      template_name: "[SMOKE] template approval card",
      proposed_by: "smoke",
      proposed_reason:
        "End-to-end smoke for the new admin-approval-card path. Buttons are wired but operate on a zero UUID, so handlers no-op safely.",
    });
    return NextResponse.json({ kind, message_id: id, sent: !!id });
  }

  if (kind === "quota") {
    const id = await sendQuotaProposalCard({
      rep_id: 1,
      rep_name: "[SMOKE] Leo",
      current_per_pool: { normal_cn: 60, strong: 5 },
      proposed_per_pool: { normal_cn: 80, strong: 10 },
      rationale: "Smoke test — wanted to verify the quota card lands in your DM.",
      proposal_key: `smoke-${Date.now()}`,
    });
    return NextResponse.json({ kind, message_id: id, sent: !!id });
  }

  if (kind === "congress") {
    const id = await sendTacticalProposalCard({
      proposal_id: "00000000-0000-0000-0000-000000000000",
      title: "[SMOKE] tactical proposal",
      rationale:
        "Smoke test — adversary persona would say: this is a fake proposal, but the card schema is what matters.",
    });
    return NextResponse.json({ kind, message_id: id, sent: !!id });
  }

  return NextResponse.json(
    { error: `Unknown kind '${kind}', expected template|quota|congress` },
    { status: 400 },
  );
}
