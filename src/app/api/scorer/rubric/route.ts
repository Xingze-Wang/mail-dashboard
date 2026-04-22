import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { getConfig, setConfig } from "@/lib/system-config";
import { DEFAULT_INTRO_RUBRIC } from "@/lib/bench-judge";

export const dynamic = "force-dynamic";

/**
 * GET  /api/scorer/rubric — returns the current active rubric (or default).
 * PUT  /api/scorer/rubric — admin-only, body { intro_rubric: string }.
 */

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const stored = await getConfig<{
    intro_rubric?: string;
    updated_at?: string;
    updated_by?: string;
  }>("active_rubric");

  return NextResponse.json({
    intro_rubric: stored?.intro_rubric?.trim() || DEFAULT_INTRO_RUBRIC,
    default_intro_rubric: DEFAULT_INTRO_RUBRIC,
    is_default: !stored?.intro_rubric?.trim(),
    updated_at: stored?.updated_at ?? null,
    updated_by: stored?.updated_by ?? null,
  });
}

export async function PUT(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const rubric = typeof body.intro_rubric === "string" ? body.intro_rubric.trim() : "";
  if (!rubric || rubric.length < 50) {
    return NextResponse.json({ error: "intro_rubric must be a non-trivial string (≥50 chars)" }, { status: 400 });
  }
  if (rubric.length > 5000) {
    return NextResponse.json({ error: "intro_rubric too long (max 5000 chars)" }, { status: 400 });
  }

  const ok = await setConfig("active_rubric", {
    intro_rubric: rubric,
    updated_at: new Date().toISOString(),
    updated_by: gate.session.email,
  });
  if (!ok) return NextResponse.json({ error: "Failed to persist" }, { status: 500 });

  return NextResponse.json({ ok: true });
}
