// GET /api/contracts/active — what contract (if any) is active for this rep right now.
// Used by the /pipeline header card. Read-only.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date().toISOString();

  // Match priority: rep-specific > segment-only > company-wide.
  // We just return the most recent open contract that names this rep,
  // or any company-wide open contract if there's nothing rep-specific.
  const { data: repContracts } = await supabase
    .from("company_contracts")
    .select("*, company:bench_companies(name, color, thesis)")
    .eq("state", "open")
    .eq("rep_id", session.repId)
    .lte("opened_at", now)
    .gte("closes_at", now)
    .order("opened_at", { ascending: false })
    .limit(1);

  if (repContracts && repContracts.length > 0) {
    return NextResponse.json({ contract: repContracts[0], scope: "rep" });
  }

  const { data: anyContracts } = await supabase
    .from("company_contracts")
    .select("*, company:bench_companies(name, color, thesis)")
    .eq("state", "open")
    .is("rep_id", null)
    .lte("opened_at", now)
    .gte("closes_at", now)
    .order("opened_at", { ascending: false })
    .limit(1);
  if (anyContracts && anyContracts.length > 0) {
    return NextResponse.json({ contract: anyContracts[0], scope: "company" });
  }

  return NextResponse.json({ contract: null });
}
