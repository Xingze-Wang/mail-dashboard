import { NextRequest, NextResponse } from "next/server";
import { requireSenior } from "@/lib/auth-helpers";
import { listBlocks, blockEmail, blockDomain, unblock } from "@/lib/blocklist";

export const dynamic = "force-dynamic";

/**
 * GET  /api/blocklist            list all blocks (senior+)
 * POST /api/blocklist            add a block; body: { email?, domain?, reason }
 * DELETE /api/blocklist?id=xxx   remove one
 *
 * Senior + admin only — this changes who we can send to.
 */
export async function GET(req: NextRequest) {
  const gate = await requireSenior(req);
  if ("response" in gate) return gate.response;
  const blocks = await listBlocks();
  return NextResponse.json({ blocks });
}

export async function POST(req: NextRequest) {
  const gate = await requireSenior(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "reason required" }, { status: 400 });

  if (body.email) {
    const ok = await blockEmail(String(body.email), reason, gate.session.email);
    if (!ok) return NextResponse.json({ error: "Failed to block email" }, { status: 500 });
    return NextResponse.json({ ok: true, email: String(body.email).toLowerCase().trim() });
  }
  if (body.domain) {
    const ok = await blockDomain(String(body.domain), reason, gate.session.email);
    if (!ok) return NextResponse.json({ error: "Failed to block domain" }, { status: 500 });
    return NextResponse.json({ ok: true, domain: String(body.domain).toLowerCase().trim() });
  }
  return NextResponse.json({ error: "email or domain required" }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireSenior(req);
  if ("response" in gate) return gate.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await unblock(id);
  if (!ok) return NextResponse.json({ error: "Failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
