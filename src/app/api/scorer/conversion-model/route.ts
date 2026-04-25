import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { getConfig, setConfig } from "@/lib/system-config";
import { fitLR, type LRModel } from "@/lib/logistic";
import { REACHABLE_EMAIL_STATUSES } from "@/lib/status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET  /api/scorer/conversion-model — returns active LR model + fit stats.
 * POST /api/scorer/conversion-model — retrain on current data.
 *
 * Feature vector (kept small on purpose — we only have ~1000 samples, so
 * more features would overfit):
 *   [0] local_score (0-1, null → 0.5)
 *   [1] log1p(citation_count) / 10  (null → 0)
 *   [2] school_tier_1 (1 if tier=1 else 0)
 *   [3] school_tier_2
 *   [4] school_tier_3
 *   [5] is_overseas (email ends .cn → 0, else 1)
 *   [6] is_strong_tier (lead_tier='strong')
 *   [7] rep_leo  (assigned_rep_id=1)
 *   [8] rep_chenyu (2)
 *   [9] rep_ethan (3)
 *
 * Missing pipeline rows get neutral values (0.5 score, 0 citations, all
 * tier dummies 0). That way sends without feature coverage still train
 * the "domain / rep" signals.
 */

interface EmailRow { to: string | null; from: string | null; status: string | null; created_at: string | null }
interface LeadRow {
  author_email: string | null;
  local_score: number | null;
  citation_count: number | null;
  school_tier: number | null;
  lead_tier: string | null;
  assigned_rep_id: number | null;
}

const FEATURE_NAMES = [
  "local_score",
  "log_citations",
  "school_tier_1",
  "school_tier_2",
  "school_tier_3",
  "is_overseas",
  "is_strong_tier",
  "rep_leo",
  "rep_chenyu",
  "rep_ethan",
] as const;

function featureVector(lead: LeadRow | null, email: string): number[] {
  const score = typeof lead?.local_score === "number" ? lead.local_score : 0.5;
  const cites = typeof lead?.citation_count === "number" ? Math.log1p(lead.citation_count) / 10 : 0;
  const st = lead?.school_tier ?? null;
  const isOverseas = email.toLowerCase().endsWith(".cn") ? 0 : 1;
  const rep = lead?.assigned_rep_id ?? 0;
  return [
    score,
    cites,
    st === 1 ? 1 : 0,
    st === 2 ? 1 : 0,
    st === 3 ? 1 : 0,
    isOverseas,
    lead?.lead_tier === "strong" ? 1 : 0,
    rep === 1 ? 1 : 0,
    rep === 2 ? 1 : 0,
    rep === 3 ? 1 : 0,
  ];
}

/**
 * Dataset shape (dual-target, sample-weighted):
 *
 * Each unique recipient becomes one row.
 *   y = 1 if recipient was clicked OR added on WeChat
 *   y = 0 otherwise
 *
 * Sample weights:
 *   wechat-positive recipient → WECHAT_WEIGHT (default 4.0)
 *   click-only positive       → CLICK_WEIGHT (default 1.0)
 *   negative                  → 1.0
 *
 * Why this shape: we have ~6 wechat events but ~30+ click events. Training
 * only on wechat is too few labels; training only on clicks ignores the
 * stronger signal. Weighting lets one model learn from the high-volume
 * proxy signal (CTR) while still respecting that wechat-add is N× more
 * informative per event. As wechat data grows, lower the multiplier.
 */
const WECHAT_WEIGHT = 4.0;
const CLICK_WEIGHT = 1.0;

async function loadDataset(): Promise<{
  X: number[][];
  y: number[];
  weights: number[];
  stats: { recipients: number; clicked: number; wechat: number; either: number };
}> {
  // Email send log (ground truth). Pull ALL non-bounced statuses, including
  // 'complained', so a clicked-then-complained recipient still appears as a
  // training row. The recipient's status field is monotonic (latest event
  // wins), so we cannot detect their click from the row alone — we union
  // with webhook_events below.
  const allEmails: EmailRow[] = [];
  let cursor = 0;
  const pageSize = 1000;
  const TRAINING_STATUSES = [...REACHABLE_EMAIL_STATUSES, "complained"];
  while (true) {
    const { data } = await supabase
      .from("emails")
      .select("id, to, status, created_at")
      .in("status", TRAINING_STATUSES)
      .range(cursor, cursor + pageSize - 1);
    if (!data || data.length === 0) break;
    allEmails.push(...(data as (EmailRow & { id: string })[]));
    if (data.length < pageSize) break;
    cursor += pageSize;
    if (cursor > 20_000) break;
  }

  // Per recipient: keep the first send (for features) AND track whether
  // ANY of their sends ever reached "clicked" status — either as the latest
  // status on the email row, OR as a recorded webhook event. Without the
  // webhook union we silently undercount clicks (anyone clicked-then-
  // complained looked like a non-click), which biased the model toward
  // "nobody converts".
  const firstByRecipient = new Map<string, EmailRow>();
  const clickedRecipients = new Set<string>();
  const emailIdToRecipient = new Map<string, string>();
  for (const e of allEmails as (EmailRow & { id: string })[]) {
    const em = (e.to ?? "").toLowerCase().trim();
    if (!em) continue;
    emailIdToRecipient.set(e.id, em);
    const prev = firstByRecipient.get(em);
    if (!prev || (e.created_at && prev.created_at && e.created_at < prev.created_at)) {
      firstByRecipient.set(em, e);
    }
    if (e.status === "clicked") clickedRecipients.add(em);
  }

  // Pull recorded click webhooks. Page through in case the table grew.
  let whCursor = 0;
  while (true) {
    const { data: whPage } = await supabase
      .from("webhook_events")
      .select("email_id")
      .eq("type", "email.clicked")
      .range(whCursor, whCursor + pageSize - 1);
    if (!whPage || whPage.length === 0) break;
    for (const w of whPage) {
      const eid = (w as { email_id: string | null }).email_id;
      if (!eid) continue;
      const em = emailIdToRecipient.get(eid);
      if (em) clickedRecipients.add(em);
    }
    if (whPage.length < pageSize) break;
    whCursor += pageSize;
    if (whCursor > 20_000) break;
  }

  const { data: leadsRaw } = await supabase
    .from("pipeline_leads")
    .select("author_email, local_score, citation_count, school_tier, lead_tier, assigned_rep_id");
  const leadsByEmail = new Map<string, LeadRow>();
  for (const l of (leadsRaw ?? []) as LeadRow[]) {
    const em = (l.author_email ?? "").toLowerCase().trim();
    if (em) leadsByEmail.set(em, l);
  }

  const { data: wechatRaw } = await supabase
    .from("brief_lookups")
    .select("query")
    .eq("added_wechat", true);
  const wechatEmails = new Set(
    (wechatRaw ?? [])
      .map((w) => (w.query as string | null)?.toLowerCase().trim())
      .filter(Boolean) as string[],
  );

  const X: number[][] = [];
  const y: number[] = [];
  const weights: number[] = [];
  let nClicked = 0;
  let nWechat = 0;
  let nEither = 0;
  for (const [em] of firstByRecipient) {
    X.push(featureVector(leadsByEmail.get(em) ?? null, em));
    const isClick = clickedRecipients.has(em);
    const isWechat = wechatEmails.has(em);
    const isPositive = isClick || isWechat;
    y.push(isPositive ? 1 : 0);
    // Weight: wechat dominates; click is the volume signal; otherwise 1.
    if (isWechat) weights.push(WECHAT_WEIGHT);
    else if (isClick) weights.push(CLICK_WEIGHT);
    else weights.push(1.0);
    if (isClick) nClicked++;
    if (isWechat) nWechat++;
    if (isPositive) nEither++;
  }
  // Shuffle deterministically so train/test split isn't sorted by recipient string.
  const seed = 42;
  const idx = X.map((_, i) => i);
  let a = seed;
  const rng = () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), a / 0x7fffffff);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return {
    X: idx.map((i) => X[i]),
    y: idx.map((i) => y[i]),
    weights: idx.map((i) => weights[i]),
    stats: { recipients: X.length, clicked: nClicked, wechat: nWechat, either: nEither },
  };
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const model = await getConfig<LRModel & { trained_at: string; trained_by: string }>("active_conversion_model");
  return NextResponse.json({ model });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { X, y, weights, stats } = await loadDataset();
  if (X.length < 50) {
    return NextResponse.json(
      { error: `Not enough data: ${X.length} samples. Need ≥50 to train a stable model.` },
      { status: 400 },
    );
  }
  if (stats.either < 5) {
    return NextResponse.json(
      { error: `Not enough positive samples: ${stats.either} (clicks=${stats.clicked}, wechat=${stats.wechat}). Need ≥5 either.` },
      { status: 400 },
    );
  }

  const model = fitLR(X, y, [...FEATURE_NAMES], {
    learningRate: 0.1,
    l2: 0.02,
    maxIter: 800,
    tolerance: 1e-5,
    trainFrac: 0.8,
    sampleWeights: weights,
  });

  const record = {
    ...model,
    trained_at: new Date().toISOString(),
    trained_by: gate.session.email,
    // Track the dual-label composition so admins can see what the model trained on.
    label_stats: stats,
    label_weights: { wechat: WECHAT_WEIGHT, click: CLICK_WEIGHT },
  };
  await setConfig("active_conversion_model", record);
  return NextResponse.json({ ok: true, model: record });
}
