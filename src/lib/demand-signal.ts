// src/lib/demand-signal.ts
//
// Multi-model demand calibration. The question we're answering:
// **how well does each scoring model predict actual recipient strength?**
//
// We don't ask the congress to define what "demand" means from scratch
// (that was an earlier framing). Instead:
//   1. Compute an "actual strength" from observed behavior — clicks,
//      wechats, replies, multi-clicks.
//   2. For each scoring model we have (local_score / lead_tier / future
//      gemini-scorer / etc), compare predicted vs actual strength.
//   3. Surface where each model is well-calibrated, where it's not,
//      and which leads are biggest miscalibrations.
//
// The congress can chime in *afterward* to read the calibration results
// and propose strategy adjustments — but it's not the one defining
// what gets measured.

import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";

// "Actual strength" — a deterministic function of observed events.
// Higher score = more demand-like behavior.
//
// We use a simple weighted formula (not a learned model) because the
// goal is to *measure prediction skill*, not to model the world. If we
// learn the actual function from the data we'd overfit and can't tell
// which scorer is good.
const ACTUAL_WEIGHTS = {
  click: 1.0,                      // first click
  click_multi_factor: 0.5,         // each additional unique-IP click adds 50%
  click_dedup_window_min: 5,       // same-IP clicks within 5 min collapse
  wechat: 3.0,                     // adding wechat is a strong intent signal
  reply: 5.0,                      // typing a reply is the strongest signal
};

interface ClickEvent { ip?: string; ts: string; link?: string }

interface LeadStrength {
  lead_id: string;
  author_email: string;
  observed_score: number;
  events: { open: number; click_total: number; click_deduped: number; wechat: number; reply: number };
}

async function computeActualStrength(leadIds: string[]): Promise<Map<string, LeadStrength>> {
  const result = new Map<string, LeadStrength>();
  if (leadIds.length === 0) return result;

  // Pull leads + their email rows in bulk
  const { data: leads } = await supabase.from("pipeline_leads").select("id, author_email").in("id", leadIds);
  const emailToLead = new Map<string, string>();
  for (const l of leads ?? []) emailToLead.set((l.author_email as string).toLowerCase(), l.id as string);

  // Pull all emails matching these recipient emails
  const recipientEmails = Array.from(emailToLead.keys());
  if (recipientEmails.length === 0) return result;

  // Lark-friendly: chunk the emails since we use ilike per row.
  const emailIdToLead = new Map<string, string>();
  for (const re of recipientEmails) {
    const { data: emailRows } = await supabase
      .from("emails").select("id").ilike("to", `%${re}%`).limit(10);
    for (const er of emailRows ?? []) emailIdToLead.set(er.id as string, emailToLead.get(re)!);
  }
  const allEmailIds = Array.from(emailIdToLead.keys());

  // Pull webhook events
  const eventsByLead = new Map<string, ClickEvent[]>();
  const opensByLead = new Map<string, number>();
  if (allEmailIds.length > 0) {
    const { data: events } = await supabase
      .from("webhook_events").select("type, payload, email_id").in("email_id", allEmailIds);
    for (const ev of events ?? []) {
      const lid = emailIdToLead.get(ev.email_id as string);
      if (!lid) continue;
      if (ev.type === "email.opened") {
        opensByLead.set(lid, (opensByLead.get(lid) ?? 0) + 1);
      } else if (ev.type === "email.clicked") {
        const p = (ev.payload as Record<string, unknown>) ?? {};
        const data = (p.data as Record<string, unknown>) ?? {};
        const click = (data.click ?? {}) as { ipAddress?: string; link?: string; timestamp?: string };
        if (!eventsByLead.has(lid)) eventsByLead.set(lid, []);
        eventsByLead.get(lid)!.push({ ip: click.ipAddress, ts: click.timestamp ?? "", link: click.link });
      }
    }
  }

  // Wechat: bulk query
  const { data: wechats } = await supabase
    .from("brief_lookups").select("lead_id").eq("added_wechat", true).in("lead_id", leadIds);
  const wechatLeads = new Set((wechats ?? []).map((w) => w.lead_id as string));

  // Replies: bulk via inbound_emails
  const { data: replies } = await supabase
    .from("inbound_emails").select("from").in("from", recipientEmails);
  const replyEmails = new Set((replies ?? []).map((r) => (r.from as string).toLowerCase()));

  // Compute strength per lead
  for (const [email, leadId] of emailToLead.entries()) {
    const opens = opensByLead.get(leadId) ?? 0;
    const clicks = eventsByLead.get(leadId) ?? [];
    const winMs = ACTUAL_WEIGHTS.click_dedup_window_min * 60_000;
    const sortedClicks = [...clicks].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const dedup: ClickEvent[] = [];
    for (const c of sortedClicks) {
      const last = dedup[dedup.length - 1];
      if (last && last.ip === c.ip && Math.abs(new Date(c.ts).getTime() - new Date(last.ts).getTime()) < winMs) continue;
      dedup.push(c);
    }
    const clickN = dedup.length;
    const wechatHit = wechatLeads.has(leadId) ? 1 : 0;
    const replyHit = replyEmails.has(email) ? 1 : 0;

    let observed = 0;
    if (clickN >= 1) observed += ACTUAL_WEIGHTS.click;
    if (clickN >= 2) observed += (clickN - 1) * ACTUAL_WEIGHTS.click * ACTUAL_WEIGHTS.click_multi_factor;
    observed += wechatHit * ACTUAL_WEIGHTS.wechat;
    observed += replyHit * ACTUAL_WEIGHTS.reply;

    result.set(leadId, {
      lead_id: leadId,
      author_email: email,
      observed_score: Number(observed.toFixed(3)),
      events: { open: opens, click_total: clicks.length, click_deduped: clickN, wechat: wechatHit, reply: replyHit },
    });
  }
  return result;
}

// ── Calibrate one scoring model against actual strength ──────────────

export interface ModelCalibration {
  model: string;                    // "local_score" | "lead_tier" | etc
  n: number;
  // Pearson correlation between predicted and actual.
  pearson: number;
  // Spearman rank correlation (more robust to non-linearity).
  spearman: number;
  // Mean absolute error after both are min-max scaled to [0, 1].
  mae_normalized: number;
  // Top-k miscalibrations: leads where prediction and actual disagree most.
  // Positive diff = model under-predicted (lead was stronger than it said).
  big_misses: Array<{ lead_id: string; predicted: number; actual: number; diff: number }>;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

function ranks(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(xs.length);
  for (let i = 0; i < indexed.length; i++) ranks[indexed[i].i] = i + 1;
  return ranks;
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(ranks(xs), ranks(ys));
}

export async function calibrateModels(opts: { lookbackDays?: number; limit?: number } = {}): Promise<{
  ok: boolean;
  measured_at: string;
  n_leads: number;
  models: ModelCalibration[];
  error?: string;
}> {
  const lookback = opts.lookbackDays ?? 60;
  const limit = opts.limit ?? 300;
  const since = new Date(Date.now() - lookback * 86_400_000).toISOString();

  // Pull recently-sent leads with the scorer outputs we have.
  const { data: leads } = await supabase
    .from("pipeline_leads")
    .select("id, author_email, local_score, lead_tier, citation_count, h_index, status, sent_at")
    .gte("sent_at", since)
    .in("status", ["sent", "replied", "skipped"])
    .order("sent_at", { ascending: false })
    .limit(limit);

  if (!leads || leads.length === 0) {
    return { ok: true, measured_at: new Date().toISOString(), n_leads: 0, models: [] };
  }

  const strengthByLead = await computeActualStrength(leads.map((l) => l.id as string));

  // Define each "model" we want to calibrate.
  type LeadRow = { id: string; local_score: number | null; lead_tier: string | null; citation_count: number | null; h_index: number | null };
  const modelDefs: Array<{ name: string; predict: (l: LeadRow) => number | null }> = [
    { name: "local_score", predict: (l) => l.local_score != null ? Number(l.local_score) : null },
    { name: "lead_tier",   predict: (l) => l.lead_tier === "strong" ? 1.0 : l.lead_tier === "normal" ? 0.5 : null },
    { name: "citation_count_log", predict: (l) => l.citation_count != null ? Math.log10(Math.max(1, Number(l.citation_count) + 1)) / 4 : null },
    { name: "h_index_normalized", predict: (l) => l.h_index != null ? Math.min(1, Number(l.h_index) / 50) : null },
  ];

  const models: ModelCalibration[] = [];
  for (const m of modelDefs) {
    const pairs: Array<{ lead_id: string; predicted: number; actual: number }> = [];
    for (const l of leads) {
      const p = m.predict(l);
      const s = strengthByLead.get(l.id as string);
      if (p == null || !s) continue;
      pairs.push({ lead_id: l.id as string, predicted: p, actual: s.observed_score });
    }
    if (pairs.length < 5) {
      models.push({ model: m.name, n: pairs.length, pearson: 0, spearman: 0, mae_normalized: 0, big_misses: [] });
      continue;
    }
    const xs = pairs.map((p) => p.predicted);
    const ys = pairs.map((p) => p.actual);
    // Min-max normalize both for MAE.
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rangeX = Math.max(1e-6, maxX - minX);
    const rangeY = Math.max(1e-6, maxY - minY);
    const mae = pairs.reduce((s, p) =>
      s + Math.abs(((p.predicted - minX) / rangeX) - ((p.actual - minY) / rangeY)), 0) / pairs.length;
    // Top-k big misses (sort by |diff in normalized space|)
    const withDiff = pairs.map((p) => ({
      ...p,
      diff: ((p.actual - minY) / rangeY) - ((p.predicted - minX) / rangeX),
    }));
    const big_misses = [...withDiff].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 8);
    models.push({
      model: m.name,
      n: pairs.length,
      pearson: Number(pearson(xs, ys).toFixed(3)),
      spearman: Number(spearman(xs, ys).toFixed(3)),
      mae_normalized: Number(mae.toFixed(3)),
      big_misses,
    });
  }

  return { ok: true, measured_at: new Date().toISOString(), n_leads: leads.length, models };
}

// ── Optional: have the congress comment on the calibration ──────────
//
// Not the primary flow. Triggered manually from /scorer/demand → "ask
// congress for interpretation". Reads the calibration table and a few
// big-miss examples, returns 1-2 paragraphs of strategic interpretation.

export async function congressInterpretCalibration(calibration: Awaited<ReturnType<typeof calibrateModels>>): Promise<{ ok: boolean; commentary?: string; error?: string }> {
  if (!calibration.ok || calibration.n_leads === 0) {
    return { ok: false, error: "no calibration data to interpret" };
  }

  // Sample a few big misses across models for the prompt.
  const bigSamples = calibration.models.slice(0, 4).flatMap((m) => m.big_misses.slice(0, 3).map((b) => ({ model: m.model, ...b })));

  const userPrompt = `## Calibration result (n=${calibration.n_leads} leads, last 60 days)

For each scoring model, here's how its predictions correlated with the actual strength signal we observed (clicks + wechats + replies):

${calibration.models.map((m) => `### ${m.model}
- n=${m.n}
- Pearson corr: ${m.pearson}
- Spearman rank corr: ${m.spearman}
- MAE (normalized): ${m.mae_normalized}`).join("\n\n")}

## Sample big misses (where prediction and actual diverged most)

${bigSamples.map((s) => `- ${s.model}: lead ${s.lead_id.slice(0, 12)} predicted=${s.predicted.toFixed(2)} actual=${s.actual.toFixed(2)} diff=${s.diff.toFixed(2)}`).join("\n")}

## Task

Two paragraphs only:
1. **Diagnosis**: which model is most calibrated? Where does each fail (high-volume noise / low-volume undercount / lead_tier coarseness / etc)?
2. **One concrete strategy ask**: what should we change next quarter — re-train the scorer with X feature, replace lead_tier with continuous Y, raise the threshold for Z?

Be specific. Cite the numbers above. Don't hedge.`;

  try {
    const r = await llmChat({
      model: "claude-opus-4.7",
      system: "你是 chief data officer. 你看 model 的 calibration 表然后给战略 take. 不绕弯子, 不堆术语.",
      user: userPrompt,
      temperature: 0.3,
      max_tokens: 1500,
      timeoutMs: 90_000,
    });
    return { ok: true, commentary: r.text?.trim() ?? "" };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}
