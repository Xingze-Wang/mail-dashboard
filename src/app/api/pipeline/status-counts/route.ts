// GET /api/pipeline/status-counts
//
// Returns the per-status breakdown for pipeline_leads matching the
// current session's scope (admin = global, rep = their assigned).
// All numbers come from canonical-counts.countLeadsByStatus so the
// /pipeline status chips, the stat strip, and the sidebar badge all
// quote the same primitive.
//
// Optional ?rep_id=<n> param: admin can scope to a specific rep.
// Non-admin sessions IGNORE this param — they're hard-scoped to self.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { countLeadsByStatus, countReadyQueue } from "@/lib/canonical-counts";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isPrivileged = session.role === "admin";
  const { searchParams } = new URL(req.url);
  const repIdParam = searchParams.get("rep_id");
  let scopeRepId: number | undefined;
  if (isPrivileged) {
    if (repIdParam) {
      const n = parseInt(repIdParam, 10);
      if (Number.isFinite(n)) scopeRepId = n;
    }
  } else {
    scopeRepId = session.repId;
  }

  const filter = scopeRepId !== undefined ? { repId: scopeRepId } : {};
  const [breakdown, readySplit] = await Promise.all([
    countLeadsByStatus(filter),
    countReadyQueue(filter),
  ]);

  return NextResponse.json({
    total: breakdown.total,
    byStatus: breakdown.byStatus,
    contacted: breakdown.contacted,
    replied: breakdown.replied,
    // Ready is special — needs the sendable/ripening split that the
    // chip ("Ready X / Ripening Y") and the stat card both display.
    ready: {
      total: readySplit.total,
      sendable: readySplit.sendable,
      ripening: readySplit.ripening,
    },
    scope: scopeRepId !== undefined ? { repId: scopeRepId } : { global: true },
  });
}
