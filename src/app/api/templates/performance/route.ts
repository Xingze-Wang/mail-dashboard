import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/templates/performance?days=30
 *
 * Per-template performance over a window. For each email_templates
 * row, joins via emails.template_id (migration 032) → email_history
 * (Tier 2 view: was_clicked is union of webhook events + status, so
 * clicks-then-complaints still count) and brief_lookups
 * (added_wechat).
 *
 * Returns per template:
 *   - sent: distinct emails using this template in window
 *   - clicked / wechat: counts of those emails that ever-clicked /
 *     converted (wechat_at within window)
 *   - clickRate / wechatRate: ratios with denominator guards
 *   - vsBaseline: rate / org-wide rate (so reviewers see lift)
 *
 * Admin-only because per-rep template stats name reps and reveal
 * relative performance — sales-side surface area should stay in
 * the rep's own /scorer view.
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const days = Math.max(7, Math.min(180, Number(url.searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Pull all templates (active + inactive — admin needs to see deprecated
  // ones to compare rollout impact).
  const { data: templates, error: tplErr } = await supabase
    .from("email_templates")
    .select("id, name, rep_id, active, created_at, updated_at")
    .order("rep_id", { ascending: true, nullsFirst: true })
    .order("name", { ascending: true });
  if (tplErr) return NextResponse.json({ error: tplErr.message }, { status: 500 });

  // Pull emails in window (by template_id). One round-trip then we
  // bucket in JS — cheaper than N queries per template.
  const { data: emails, error: eErr } = await supabase
    .from("emails")
    .select("id, template_id, to")
    .gte("created_at", since)
    .not("template_id", "is", null);
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 });

  const emailIds = (emails ?? []).map((e) => e.id as string);
  const recipientSet = new Set(
    (emails ?? []).map((e) => String(e.to ?? "").toLowerCase().trim()).filter(Boolean),
  );

  // Click outcomes via email_history (Tier 2 view). postgrest's `.in()`
  // builds a URL-length-limited query — over ~200-500 ids returns a
  // silent 400 with empty body. Chunk to keep each query small. The
  // sets are union-merged.
  const clickedSet = new Set<string>();
  const CHUNK = 150;
  for (let i = 0; i < emailIds.length; i += CHUNK) {
    const chunk = emailIds.slice(i, i + CHUNK);
    const { data: clicks } = await supabase
      .from("email_history")
      .select("email_id")
      .in("email_id", chunk)
      .eq("was_clicked", true);
    for (const r of clicks ?? []) clickedSet.add(r.email_id as string);
  }

  // WeChat conversions in window matched to recipients we sent to.
  // brief_lookups is the canonical actor-attributed table.
  const { data: wechatRows } = recipientSet.size > 0
    ? await supabase
        .from("brief_lookups")
        .select("query, wechat_at")
        .eq("added_wechat", true)
        .gte("wechat_at", since)
    : { data: [] };
  const wechatRecipients = new Set(
    (wechatRows ?? [])
      .map((r) => String(r.query ?? "").toLowerCase().trim())
      .filter((e) => recipientSet.has(e)),
  );

  // Bucket per template.
  type Bucket = { sent: number; clicked: number; wechat: number };
  const byTemplate = new Map<string, Bucket>();
  for (const e of emails ?? []) {
    const tid = e.template_id as string | null;
    if (!tid) continue;
    const b = byTemplate.get(tid) ?? { sent: 0, clicked: 0, wechat: 0 };
    b.sent++;
    if (clickedSet.has(e.id as string)) b.clicked++;
    if (wechatRecipients.has(String(e.to ?? "").toLowerCase().trim())) b.wechat++;
    byTemplate.set(tid, b);
  }

  // Org baselines for vs-baseline lift.
  const totalSent = emails?.length ?? 0;
  const totalClicked = clickedSet.size;
  const totalWechat = wechatRecipients.size;
  const baseClick = totalSent > 0 ? totalClicked / totalSent : 0;
  const baseWechat = totalSent > 0 ? totalWechat / totalSent : 0;

  const rows = (templates ?? []).map((t) => {
    const b = byTemplate.get(t.id as string) ?? { sent: 0, clicked: 0, wechat: 0 };
    const clickRate = b.sent > 0 ? b.clicked / b.sent : 0;
    const wechatRate = b.sent > 0 ? b.wechat / b.sent : 0;
    return {
      id: t.id,
      name: t.name,
      rep_id: t.rep_id,
      active: t.active,
      updated_at: t.updated_at,
      sent: b.sent,
      clicked: b.clicked,
      wechat: b.wechat,
      clickRate,
      wechatRate,
      // Lift only meaningful with ≥10 sends in window — otherwise it's
      // mostly noise. Caller can ignore the value when sent<10.
      vsClickBaseline: baseClick > 0 ? clickRate / baseClick : 0,
      vsWechatBaseline: baseWechat > 0 ? wechatRate / baseWechat : 0,
    };
  });

  return NextResponse.json({
    windowDays: days,
    baseline: { totalSent, totalClicked, totalWechat, clickRate: baseClick, wechatRate: baseWechat },
    templates: rows,
  });
}
