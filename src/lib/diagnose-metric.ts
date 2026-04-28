// Diagnose-metric-drop helper (Dream #2).
//
// When the helper says "click rate dropped 40% week-over-week," reps
// don't get to "what should I change?" without manually digging. This
// loads cur vs prev windows for one metric and surfaces the covariates
// that shifted most — giving the helper an evidence-backed list of
// candidate explanations to chew on.
//
// Cheap, deliberately limited: only two metrics (click_rate,
// wechat_rate) and four covariates (subject_length_bucket, lead_tier,
// school_tier, geo). Adding more is one switch case + one column read.
//
// Returns evidence-style cards the helper can quote directly. Never
// asserts causality — every card is "X shifted Y%, that's the kind
// of thing that explains the change."

import { supabase } from "@/lib/db";

export type DiagnoseMetric = "click_rate" | "wechat_rate";

export interface DiagnoseCard {
  covariate: string;
  prevDistribution: Record<string, number>;
  curDistribution: Record<string, number>;
  biggestShift: { bucket: string; from: number; to: number; deltaPct: number };
  hypothesis: string;
}

export interface DiagnoseResult {
  metric: DiagnoseMetric;
  windowDays: number;
  prevRate: number;
  curRate: number;
  ratioChange: number;
  noise: boolean;
  cards: DiagnoseCard[];
}

interface EmailRow {
  id: string;
  subject: string | null;
  to: string | null;
  created_at: string;
  rep_id: number | null;
}

interface EmailHistoryRow {
  email_id: string;
  was_clicked: boolean;
}

interface BriefRow {
  // brief_lookups stores the recipient address in `query` (the lookup
  // string the rep used when adding the wechat mark). NOT
  // recipient_email — that column doesn't exist.
  query: string | null;
  marked_by_rep_id: number | null;
  wechat_at: string | null;
}

interface PipelineRow {
  author_email: string | null;
  lead_tier: string | null;
  school_tier: number | null;
}

function pct(rows: number, total: number): number {
  return total > 0 ? rows / total : 0;
}

function bucketSubjectLength(subject: string | null): string {
  const len = (subject ?? "").trim().length;
  if (len === 0) return "empty";
  if (len <= 4) return "1-4";
  if (len <= 8) return "5-8";
  if (len <= 14) return "9-14";
  return "15+";
}

function bucketGeo(email: string | null): string {
  if (!email) return "unknown";
  const lower = email.toLowerCase();
  if (lower.endsWith(".cn")) return "cn";
  if (lower.endsWith(".edu") || lower.endsWith(".edu.cn")) return "edu";
  return "other";
}

function distribution(rows: { bucket: string }[]): Record<string, number> {
  const total = rows.length;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) out[k] = pct(v, total);
  return out;
}

function biggestShift(prev: Record<string, number>, cur: Record<string, number>) {
  const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  let best: { bucket: string; from: number; to: number; deltaPct: number } | null = null;
  for (const k of keys) {
    const from = prev[k] ?? 0;
    const to = cur[k] ?? 0;
    const delta = to - from;
    if (best == null || Math.abs(delta) > Math.abs(best.deltaPct / 100)) {
      best = { bucket: k, from, to, deltaPct: delta * 100 };
    }
  }
  return best!;
}

export async function diagnoseMetricDrop(opts: {
  metric: DiagnoseMetric;
  repId?: number | null;
  days?: number;
}): Promise<DiagnoseResult | { error: string }> {
  const metric = opts.metric;
  const days = Math.max(7, Math.min(60, opts.days ?? 7));
  const repId = opts.repId ?? null;

  const now = Date.now();
  const curStart = new Date(now - days * 86_400_000).toISOString();
  const prevStart = new Date(now - 2 * days * 86_400_000).toISOString();

  // Resolve sender_email if rep-scoped — same convention as
  // /api/emails. For metric-drop diagnosis at admin level, leave null.
  let fromIlike: string | null = null;
  if (repId != null) {
    const { data: rep } = await supabase
      .from("sales_reps")
      .select("sender_email")
      .eq("id", repId)
      .maybeSingle();
    if (rep?.sender_email) fromIlike = `%${rep.sender_email}%`;
  }

  const buildEmailsQuery = (start: string, end: string) => {
    let q = supabase
      .from("emails")
      .select("id, subject, to, created_at, rep_id")
      .gte("created_at", start)
      .lt("created_at", end);
    if (fromIlike) q = q.ilike("from", fromIlike);
    return q;
  };

  const [{ data: curEmails }, { data: prevEmails }] = await Promise.all([
    buildEmailsQuery(curStart, new Date(now).toISOString()),
    buildEmailsQuery(prevStart, curStart),
  ]);

  const cur = (curEmails ?? []) as EmailRow[];
  const prev = (prevEmails ?? []) as EmailRow[];
  if (cur.length === 0 && prev.length === 0) {
    return { error: "no emails in either window" };
  }
  if (cur.length < 20 || prev.length < 20) {
    // Not enough volume to claim a drop without lying. Return
    // null-result rather than fake confidence.
    return {
      metric,
      windowDays: days,
      prevRate: 0,
      curRate: 0,
      ratioChange: 0,
      noise: true,
      cards: [],
    };
  }

  // Compute the metric rate in each window.
  const curIds = cur.map((r) => r.id);
  const prevIds = prev.map((r) => r.id);

  let curHits = 0;
  let prevHits = 0;
  if (metric === "click_rate") {
    const [{ data: curHits_ }, { data: prevHits_ }] = await Promise.all([
      supabase.from("email_history").select("email_id").in("email_id", curIds).eq("was_clicked", true),
      supabase.from("email_history").select("email_id").in("email_id", prevIds).eq("was_clicked", true),
    ]);
    curHits = ((curHits_ ?? []) as EmailHistoryRow[]).length;
    prevHits = ((prevHits_ ?? []) as EmailHistoryRow[]).length;
  } else if (metric === "wechat_rate") {
    const [{ data: curBriefs }, { data: prevBriefs }] = await Promise.all([
      supabase
        .from("brief_lookups")
        .select("query, marked_by_rep_id, wechat_at")
        .eq("added_wechat", true)
        .gte("wechat_at", curStart),
      supabase
        .from("brief_lookups")
        .select("query, marked_by_rep_id, wechat_at")
        .eq("added_wechat", true)
        .gte("wechat_at", prevStart)
        .lt("wechat_at", curStart),
    ]);
    const matchSet = (briefs: BriefRow[], emails: EmailRow[]) => {
      const recips = new Set(emails.map((e) => (e.to ?? "").toLowerCase().trim()).filter(Boolean));
      let n = 0;
      for (const b of briefs) {
        if (repId != null && b.marked_by_rep_id !== repId) continue;
        if (b.query && recips.has(b.query.toLowerCase().trim())) n++;
      }
      return n;
    };
    curHits = matchSet((curBriefs ?? []) as BriefRow[], cur);
    prevHits = matchSet((prevBriefs ?? []) as BriefRow[], prev);
  }

  const prevRate = pct(prevHits, prev.length);
  const curRate = pct(curHits, cur.length);
  const ratioChange = prevRate > 0 ? curRate / prevRate - 1 : 0;

  // Pull lead enrichments for the union of emails — covariate
  // distributions need lead_tier / school_tier from pipeline_leads.
  const recipients = Array.from(
    new Set([...cur, ...prev].map((e) => (e.to ?? "").toLowerCase().trim()).filter(Boolean)),
  );
  const { data: leads } = recipients.length > 0
    ? await supabase
        .from("pipeline_leads")
        .select("author_email, lead_tier, school_tier")
        .in("author_email", recipients)
    : { data: [] as PipelineRow[] };
  const leadByEmail = new Map<string, PipelineRow>();
  for (const l of (leads ?? []) as PipelineRow[]) {
    if (l.author_email) leadByEmail.set(l.author_email.toLowerCase().trim(), l);
  }

  // Build covariate buckets per email.
  const enrich = (rows: EmailRow[]) => ({
    subject_length: rows.map((r) => ({ bucket: bucketSubjectLength(r.subject) })),
    geo: rows.map((r) => ({ bucket: bucketGeo(r.to) })),
    lead_tier: rows.map((r) => {
      const lead = leadByEmail.get((r.to ?? "").toLowerCase().trim());
      return { bucket: lead?.lead_tier ?? "unknown" };
    }),
    school_tier: rows.map((r) => {
      const lead = leadByEmail.get((r.to ?? "").toLowerCase().trim());
      return { bucket: lead?.school_tier ? `tier-${lead.school_tier}` : "unknown" };
    }),
  });

  const curBuckets = enrich(cur);
  const prevBuckets = enrich(prev);

  const cards: DiagnoseCard[] = [];
  for (const cov of ["subject_length", "geo", "lead_tier", "school_tier"] as const) {
    const prevDist = distribution(prevBuckets[cov]);
    const curDist = distribution(curBuckets[cov]);
    const shift = biggestShift(prevDist, curDist);
    if (Math.abs(shift.deltaPct) < 5) continue; // <5pp shift isn't load-bearing
    cards.push({
      covariate: cov,
      prevDistribution: prevDist,
      curDistribution: curDist,
      biggestShift: shift,
      hypothesis: `${cov} 的 "${shift.bucket}" 这块 share 从 ${(shift.from * 100).toFixed(0)}% → ${(shift.to * 100).toFixed(0)}% (${shift.deltaPct >= 0 ? "+" : ""}${shift.deltaPct.toFixed(0)}pp). 如果你那一类的 ${metric} 本来就偏低/偏高, 可以解释整体的变化.`,
    });
  }

  // Sort cards by absolute shift magnitude — most explanatory first.
  cards.sort((a, b) => Math.abs(b.biggestShift.deltaPct) - Math.abs(a.biggestShift.deltaPct));

  return {
    metric,
    windowDays: days,
    prevRate,
    curRate,
    ratioChange,
    noise: false,
    cards: cards.slice(0, 3),
  };
}
