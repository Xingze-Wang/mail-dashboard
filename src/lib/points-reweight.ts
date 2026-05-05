// Continuous points-table reweighter.
//
// Fit a small ridge logistic regression over the last N days of leads:
//   features = bag of intermediate-event counts per (lead_id, sender_email)
//   target   = "lead converted" (proxy = wechat-then-reply-7d until real
//              submission events flow through)
// The fitted coefficients (after L2 regularization) become the new
// points-table weights, normalized so the total weight stays in a
// reasonable range. Uncertainty = 1 / sqrt(diag(Hessian)).
//
// This is deliberately small + readable (no numpy / no R). Newton steps
// stop at convergence or 12 iterations.

import { supabase } from "@/lib/db";

type EventKind = "open" | "click" | "wechat" | "reply" | "submission";

const FEATURES: EventKind[] = ["open", "click", "wechat", "reply"]; // submission is the target/terminal
const RIDGE = 0.5; // L2 regularization strength
const MAX_ITERS = 12;
const CONVERGE_DELTA = 1e-4;

interface LeadFeatureRow {
  lead_key: string;
  features: Record<EventKind, number>;
  converted: 0 | 1;
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  } else {
    const e = Math.exp(x);
    return e / (1 + e);
  }
}

// Solve Ax = b for small symmetric positive-definite A via Cholesky.
function choleskySolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const L: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) return Array(n).fill(0); // not PD; abort
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  // Forward solve Ly = b
  const y = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  // Backward solve L^T x = y
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function fitRidgeLogistic(rows: LeadFeatureRow[]): { weights: Record<EventKind, number>; uncertainties: Record<EventKind, number>; converged: boolean; n: number } {
  const n = rows.length;
  const p = FEATURES.length;
  // Coefficients (no intercept on purpose — points are 0 when no events fire)
  let beta = Array(p).fill(0);

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const grad = Array(p).fill(0);
    const hess: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
    for (const r of rows) {
      const x = FEATURES.map((f) => r.features[f]);
      const linear = beta.reduce((s, b, i) => s + b * x[i], 0);
      const pHat = sigmoid(linear);
      const w = pHat * (1 - pHat);
      const err = r.converted - pHat;
      for (let i = 0; i < p; i++) {
        grad[i] += err * x[i];
        for (let j = 0; j < p; j++) hess[i][j] += w * x[i] * x[j];
      }
    }
    // Add ridge: -RIDGE * beta to gradient, +RIDGE * I to hessian
    for (let i = 0; i < p; i++) {
      grad[i] -= RIDGE * beta[i];
      hess[i][i] += RIDGE;
    }
    const step = choleskySolve(hess, grad);
    let maxDelta = 0;
    for (let i = 0; i < p; i++) {
      beta[i] += step[i];
      maxDelta = Math.max(maxDelta, Math.abs(step[i]));
    }
    if (maxDelta < CONVERGE_DELTA) break;
  }

  // Uncertainty from final hessian diagonal: SE_i ≈ sqrt(1 / H_ii)
  const finalHess: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  for (const r of rows) {
    const x = FEATURES.map((f) => r.features[f]);
    const linear = beta.reduce((s, b, i) => s + b * x[i], 0);
    const w = sigmoid(linear) * (1 - sigmoid(linear));
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) finalHess[i][j] += w * x[i] * x[j];
    }
  }
  for (let i = 0; i < p; i++) finalHess[i][i] += RIDGE;
  const uncertainties: Record<EventKind, number> = { open: 0, click: 0, wechat: 0, reply: 0, submission: 0 };
  for (let i = 0; i < p; i++) {
    uncertainties[FEATURES[i]] = finalHess[i][i] > 0 ? 1 / Math.sqrt(finalHess[i][i]) : 99;
  }

  // Map to a points scale: floor at 0 (negative weights would be confusing
  // in an "earn points" framing), then rescale so the largest non-terminal
  // weight is 5 (submission stays at 10 as the human-set anchor).
  const raw: Record<EventKind, number> = { open: 0, click: 0, wechat: 0, reply: 0, submission: 0 };
  for (let i = 0; i < p; i++) raw[FEATURES[i]] = Math.max(0, beta[i]);
  const maxRaw = Math.max(...Object.values(raw));
  const scale = maxRaw > 0 ? 5 / maxRaw : 1;
  const weights: Record<EventKind, number> = { open: 0, click: 0, wechat: 0, reply: 0, submission: 10 };
  for (const k of FEATURES) weights[k] = Number((raw[k] * scale).toFixed(2));
  return { weights, uncertainties, converged: true, n };
}

interface ReweightResult {
  status: "fit" | "insufficient_data";
  n: number;
  weights?: Record<EventKind, number>;
  uncertainties?: Record<EventKind, number>;
  prev_version?: number;
  new_version?: number;
}

/**
 * Pull lead-level feature rows from the funnel data. Uses webhook_events
 * (intermediate signals) and brief_lookups (wechat/reply proxy) over the
 * last `lookbackDays`.
 */
async function loadFeatureRows(lookbackDays: number): Promise<LeadFeatureRow[]> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  const { data: events } = await supabase
    .from("webhook_events")
    .select("type, email_id, created_at")
    .gte("created_at", since)
    .not("email_id", "is", null);

  // Need email → lead mapping. Use thread_id as the join key.
  const emailIds = Array.from(new Set((events ?? []).map((e) => e.email_id).filter(Boolean) as string[]));
  if (emailIds.length === 0) return [];
  const { data: emails } = await supabase
    .from("emails")
    .select("id, thread_id, to")
    .in("id", emailIds);
  const emailToLead = new Map<string, string>(); // email_id → recipient (lead key)
  for (const e of emails ?? []) {
    const k = (e.to as string)?.toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0] ?? null;
    if (k) emailToLead.set(e.id as string, k);
  }

  // Bag of feature counts per lead.
  const features = new Map<string, Record<EventKind, number>>();
  const inc = (lead: string, kind: EventKind, by = 1) => {
    if (!features.has(lead)) features.set(lead, { open: 0, click: 0, wechat: 0, reply: 0, submission: 0 });
    features.get(lead)![kind] += by;
  };
  for (const e of events ?? []) {
    const lead = emailToLead.get(e.email_id as string);
    if (!lead) continue;
    const t = e.type as string;
    if (t === "email.opened")  inc(lead, "open");
    else if (t === "email.clicked") inc(lead, "click");
  }

  // wechat events (proxy) from brief_lookups
  const { data: wechats } = await supabase
    .from("brief_lookups")
    .select("query, wechat_at")
    .eq("added_wechat", true)
    .gte("wechat_at", since);
  for (const w of wechats ?? []) {
    const k = (w.query as string)?.toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0] ?? null;
    if (k) inc(k, "wechat");
  }

  // reply events from inbound_emails (anyone who replied to us)
  const { data: replies } = await supabase
    .from("inbound_emails")
    .select("from, received_at")
    .gte("received_at", since);
  for (const r of replies ?? []) {
    const k = (r.from as string)?.toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0] ?? null;
    if (k) inc(k, "reply");
  }

  // Target: did this lead convert? Proxy = wechat AND reply. Replace with
  // submission once that event flows.
  const rows: LeadFeatureRow[] = [];
  for (const [lead, f] of features.entries()) {
    const converted = (f.wechat > 0 && f.reply > 0) ? 1 : 0;
    rows.push({ lead_key: lead, features: f, converted: converted as 0 | 1 });
  }
  return rows;
}

export async function reweightAndPublish(opts: { lookbackDays?: number } = {}): Promise<ReweightResult> {
  const lookback = opts.lookbackDays ?? 60;
  const rows = await loadFeatureRows(lookback);
  if (rows.length < 50) return { status: "insufficient_data", n: rows.length };

  const { weights, uncertainties, n } = fitRidgeLogistic(rows);

  // Read current version to bump.
  const { data: cur } = await supabase
    .from("points_table_versions")
    .select("id, version")
    .is("effective_to", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevVersion = (cur?.version as number) ?? 0;
  const newVersion = prevVersion + 1;

  // Close out the prior version.
  if (cur?.id) {
    await supabase.from("points_table_versions").update({ effective_to: new Date().toISOString() }).eq("id", cur.id);
  }

  // Insert the new version row.
  const { data: inserted } = await supabase
    .from("points_table_versions")
    .insert({
      version: newVersion,
      source: "auto_fit",
      effective_from: new Date().toISOString(),
      fit_metadata: {
        method: "ridge_logistic",
        ridge: RIDGE,
        lookback_days: lookback,
        n_leads: n,
        target_proxy: "wechat AND reply",
      },
      rationale: `Auto-fit on ${n} leads over ${lookback}d. Weights drift to reflect what intermediates currently predict conversion.`,
    })
    .select("id")
    .single();
  if (!inserted) return { status: "insufficient_data", n };

  // Insert weights.
  const weightRows = [
    { event_kind: "submission", weight: 10, weight_uncertainty: 0, is_terminal: true },
    { event_kind: "reply",      weight: weights.reply,  weight_uncertainty: uncertainties.reply,  is_terminal: false },
    { event_kind: "click",      weight: weights.click,  weight_uncertainty: uncertainties.click,  is_terminal: false },
    { event_kind: "wechat",     weight: weights.wechat, weight_uncertainty: uncertainties.wechat, is_terminal: false },
    { event_kind: "open",       weight: weights.open,   weight_uncertainty: uncertainties.open,   is_terminal: false },
    { event_kind: "delivered",  weight: 0,              weight_uncertainty: 0,                    is_terminal: false },
  ];
  await supabase.from("points_table_weights").insert(weightRows.map((w) => ({ ...w, version_id: inserted.id })));

  return { status: "fit", n, weights, uncertainties, prev_version: prevVersion, new_version: newVersion };
}
