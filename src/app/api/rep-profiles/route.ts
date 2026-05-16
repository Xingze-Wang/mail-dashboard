// GET  /api/rep-profiles → list all rep operating profiles (admin)
// POST /api/rep-profiles → admin manual recompute trigger

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { recomputeAllRepProfiles } from "@/lib/rep-profile";
import { getMpConversionMatrix } from "@/lib/canonical-counts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data } = await supabase
    .from("rep_operating_profile")
    .select("*, rep:sales_reps(name, sender_name)")
    .order("recomputed_at", { ascending: false });

  // Stitch per-rep MP conversion slice (90d window, matching rep-profile
  // lookback default). One bulk matrix call across all reps — same
  // primitive the home page uses — so the rep-profile consumer sees the
  // funnel state right next to the activity profile. Soft-fail keeps
  // the page rendering when MP sync degrades.
  const mpByRep = new Map<
    number,
    { registered: number; submitted: number; wechat: number; total_emailed: number; matched: number }
  >();
  try {
    const matrix = await getMpConversionMatrix({});
    for (const r of matrix.perRep ?? []) {
      mpByRep.set(r.rep_id, {
        registered: r.registered + r.submittedApplication,
        submitted: r.submittedApplication,
        wechat: r.wechatAdded,
        total_emailed: r.totalEmailed,
        matched: r.matched,
      });
    }
  } catch (err) {
    console.warn(
      "[rep-profiles] mp matrix failed",
      err instanceof Error ? err.message : err,
    );
  }

  const profiles = (data ?? []).map((p) => ({
    ...p,
    mp_90d: mpByRep.get(p.rep_id as number) ?? null,
  }));

  return NextResponse.json({ profiles });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const out = await recomputeAllRepProfiles({ lookbackDays: body.lookbackDays ?? 90 });
  return NextResponse.json(out);
}
