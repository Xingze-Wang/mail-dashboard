// GET /api/scorer/model-calibration
//
// Second scorer line — measures **how well each model predicts a lead's
// outcomes**, separate from the lead-strength scorer line.
//
// Methodology: take a sample of recently-sent leads where we already know
// real outcomes (open/click/wechat/reply counts from webhook_events +
// brief_lookups + inbound_emails). For each lead, ask each model to
// predict will_click and will_wechat. Score the model on (a) accuracy
// (predicted-class vs actual) and (b) calibration (mean predicted prob in
// each bin vs observed frequency).
//
// Returns: per-model calibration card.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

interface LeadGroundTruth {
  lead_id: string;
  title: string | null;
  author_email: string;
  citation_count: number | null;
  segment: string;            // Domestic (.cn) | Overseas
  tier: string | null;         // strong / normal
  // Actuals
  delivered: boolean;
  click_count: number;
  wechat: boolean;
  reply: boolean;
}

interface ModelPrediction {
  p_click: number;
  p_wechat: number;
  rationale: string;
}

interface ModelScore {
  model: string;
  n: number;
  click_accuracy: number;
  wechat_accuracy: number;
  click_brier: number;     // Brier score — lower = better calibrated
  wechat_brier: number;
  click_log_loss: number;
  wechat_log_loss: number;
  avg_latency_s: number;
  errors: number;
  cards: Array<{ lead_id: string; pred: ModelPrediction; actual: { click: boolean; wechat: boolean } }>;
}

const SAMPLE_SIZE = 12;
const DEFAULT_MODELS = [
  "claude-sonnet-4.6",
  "gemini-2.5-flash",
  "gpt-5-mini",
  "glm-4.7",
];

const SYSTEM = `You predict the probability that a recipient of a cold-outreach email will (a) click a link in the email and (b) add the sender on WeChat.

You are given the lead's metadata. Output strict JSON:
{ "p_click": float in [0,1], "p_wechat": float in [0,1], "rationale": "1 sentence" }

The probabilities should reflect realistic base rates (total pipeline conversion is ~10% click, ~2% WeChat). Don't anchor at 0.5 — separate the strong leads from the weak.`;

async function loadGroundTruth(): Promise<LeadGroundTruth[]> {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();

  const { data: leads } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_email, citation_count, lead_tier, status, sent_at")
    .gte("sent_at", since)
    .in("status", ["sent", "replied", "skipped"])
    .order("sent_at", { ascending: false })
    .limit(200);
  if (!leads || leads.length === 0) return [];

  const out: LeadGroundTruth[] = [];
  for (const ld of leads) {
    const email = String(ld.author_email ?? "").toLowerCase();
    if (!email) continue;
    const segment = email.endsWith(".cn") ? "Domestic (.cn)" : "Overseas";

    // Click count from webhook events.
    const { data: emailRows } = await supabase
      .from("emails").select("id").ilike("to", `%${email}%`).limit(5);
    const emailIds = (emailRows ?? []).map((e) => e.id as string);
    let clickCount = 0;
    let delivered = false;
    if (emailIds.length > 0) {
      const { data: events } = await supabase
        .from("webhook_events")
        .select("type")
        .in("email_id", emailIds);
      for (const e of events ?? []) {
        if (e.type === "email.clicked") clickCount++;
        if (e.type === "email.delivered" || e.type === "email.opened" || e.type === "email.clicked") delivered = true;
      }
    }

    // Wechat from brief_lookups.
    const { count: wechatCount } = await supabase
      .from("brief_lookups").select("*", { count: "exact", head: true })
      .eq("added_wechat", true).eq("lead_id", ld.id);
    const wechat = (wechatCount ?? 0) > 0;

    // Reply from inbound_emails (sender == author_email).
    const { count: replyCount } = await supabase
      .from("inbound_emails").select("*", { count: "exact", head: true })
      .ilike("from", `%${email}%`);
    const reply = (replyCount ?? 0) > 0;

    out.push({
      lead_id: ld.id as string,
      title: (ld.title as string | null) ?? null,
      author_email: email,
      citation_count: (ld.citation_count as number | null) ?? null,
      segment,
      tier: (ld.lead_tier as string | null) ?? null,
      delivered,
      click_count: clickCount,
      wechat,
      reply,
    });
    if (out.length >= SAMPLE_SIZE) break;
  }
  return out;
}

async function predictWith(model: string, lead: LeadGroundTruth): Promise<ModelPrediction & { latency_s: number; error?: string }> {
  const t0 = Date.now();
  const userPayload = JSON.stringify({
    title: lead.title,
    author_email: lead.author_email,
    segment: lead.segment,
    citation_count: lead.citation_count,
    tier: lead.tier,
  });
  try {
    const out = await llmChat({
      model,
      system: SYSTEM,
      user: userPayload,
      json: true,
      max_tokens: 200,
      temperature: 0.1,
      timeoutMs: 30_000,
    });
    const parsed = JSON.parse(out.text) as ModelPrediction;
    const lat = (Date.now() - t0) / 1000;
    return { ...parsed, latency_s: lat };
  } catch (err) {
    return { p_click: 0.5, p_wechat: 0.5, rationale: "ERROR", latency_s: (Date.now() - t0) / 1000, error: String(err).slice(0, 200) };
  }
}

function brier(preds: number[], actuals: number[]) {
  if (preds.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < preds.length; i++) {
    const d = preds[i] - actuals[i];
    s += d * d;
  }
  return s / preds.length;
}

function logLoss(preds: number[], actuals: number[]) {
  if (preds.length === 0) return 0;
  const eps = 1e-6;
  let s = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = Math.max(eps, Math.min(1 - eps, preds[i]));
    const y = actuals[i];
    s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return s / preds.length;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const modelsParam = url.searchParams.get("models");
  const models = modelsParam ? modelsParam.split(",").map((m) => m.trim()) : DEFAULT_MODELS;

  const truth = await loadGroundTruth();
  if (truth.length === 0) {
    return NextResponse.json({
      sample_size: 0,
      models: [],
      note: "No sent leads with outcomes in the last 60 days.",
    });
  }

  const scores: ModelScore[] = [];
  for (const model of models) {
    const cards: ModelScore["cards"] = [];
    let errors = 0;
    let totalLat = 0;
    const pClicks: number[] = [];
    const pWechats: number[] = [];
    const aClicks: number[] = [];
    const aWechats: number[] = [];

    for (const lead of truth) {
      const pred = await predictWith(model, lead);
      if (pred.error) errors++;
      totalLat += pred.latency_s;
      pClicks.push(pred.p_click);
      pWechats.push(pred.p_wechat);
      aClicks.push(lead.click_count > 0 ? 1 : 0);
      aWechats.push(lead.wechat ? 1 : 0);
      cards.push({
        lead_id: lead.lead_id,
        pred: { p_click: pred.p_click, p_wechat: pred.p_wechat, rationale: pred.rationale },
        actual: { click: lead.click_count > 0, wechat: lead.wechat },
      });
    }

    // Accuracy at threshold 0.5.
    let clickHits = 0, wechatHits = 0;
    for (let i = 0; i < truth.length; i++) {
      if ((pClicks[i] >= 0.5 ? 1 : 0) === aClicks[i]) clickHits++;
      if ((pWechats[i] >= 0.5 ? 1 : 0) === aWechats[i]) wechatHits++;
    }

    scores.push({
      model,
      n: truth.length,
      click_accuracy: Number((clickHits / truth.length).toFixed(3)),
      wechat_accuracy: Number((wechatHits / truth.length).toFixed(3)),
      click_brier: Number(brier(pClicks, aClicks).toFixed(4)),
      wechat_brier: Number(brier(pWechats, aWechats).toFixed(4)),
      click_log_loss: Number(logLoss(pClicks, aClicks).toFixed(4)),
      wechat_log_loss: Number(logLoss(pWechats, aWechats).toFixed(4)),
      avg_latency_s: Number((totalLat / truth.length).toFixed(2)),
      errors,
      cards,
    });
  }

  // Persist this run so /scorer/calibration can show drift over time.
  // Best-effort — a write failure should not lose the response we just
  // worked hard to compute.
  try {
    const { supabase } = await import("@/lib/db");
    const persistedAt = new Date().toISOString();
    const rows = scores.map((s) => ({
      model: s.model,
      n: s.n,
      click_accuracy: s.click_accuracy,
      wechat_accuracy: s.wechat_accuracy,
      click_brier: s.click_brier,
      wechat_brier: s.wechat_brier,
      click_log_loss: s.click_log_loss,
      wechat_log_loss: s.wechat_log_loss,
      avg_latency_s: s.avg_latency_s,
      errors: s.errors,
      meta: { lookback_days: 60, sample_size: truth.length },
      run_at: persistedAt,
    }));
    if (rows.length > 0) {
      await supabase.from("model_calibration_runs").insert(rows);
    }
  } catch (err) {
    console.error("[model-calibration] persistence failed", err);
  }

  return NextResponse.json({
    sample_size: truth.length,
    models: scores,
    generated_at: new Date().toISOString(),
  });
}
