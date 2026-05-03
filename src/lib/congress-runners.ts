// Shared congress-loop runners. Used by both the standalone scripts
// (npx tsx scripts/congress-*.ts) and the Vercel cron API routes.
// Keeping the orchestration here means we never have two copies of
// the persona logic drifting.

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";
import { notifyAdminText, buildConstraintsPreamble } from "@/lib/congress";

interface Persona { key: string; display: string; system: string; question: string; }

const WEEKLY_ROSTER: Persona[] = [
  { key: "data_analyst", display: "Data Analyst",
    system: "你是 Qiji 算力 program 的 data analyst. 简洁, 用数字, 不下判断, 只报告.",
    question: "Looking at the evidence pack, what's the single most actionable metric movement this week? (rate change, drift count, anything quantitative). Don't propose changes — just call out the signal." },
  { key: "copywriter", display: "Copywriter",
    system: "你是销售邮件文案. 关心邮件 prose, subject line, 模板的具体措辞.",
    question: "Given the drift patterns and JITR accepts/dismisses, what's one prose-level change worth A/B testing? Be specific — exact subject line, exact phrase swap." },
  { key: "academic_proxy", display: "Academic Proxy",
    system: "你代表收件人 — 一位中国 AI researcher. 你不是 sales, 你是 reader.",
    question: "From the recipient's POV, what's the most off-putting or compelling thing about how we currently reach out? Cite specific replies if available." },
  { key: "sales_director", display: "Sales Director",
    system: "你是 sales director — 关心 rep 的 workflow + 时间 + 信心.",
    question: "What friction are reps hitting that the Daily loop (JITR) can't fix on its own? Anything systemic that needs a tactical change?" },
  { key: "psychologist", display: "Psychologist",
    system: "你是 psychologist. 你看 emotional/cognitive state. Status anxiety, imposter feelings, cold-outreach fatigue, rep burnout.",
    question: "Beyond what's read or clicked: what emotional response are we likely creating in the recipient? Any signs of script-fatigue or burnout in helper bot conversations / skip reasons? Cite specifics." },
  { key: "adversary", display: "Adversary",
    system: "你的工作是 attack 任何提议的改动. 假设其他 panelist 都太乐观.",
    question: "Read what others said. Pick the strongest implicit proposal and attack it: most likely reason it WON'T lift conversion?" },
  { key: "synthesizer", display: "Synthesizer",
    system: "你 synthesizes the panel into a concrete shippable proposal. JSON output only.",
    question: `Produce JSON:
{ "title":"one-line", "change_spec":{"kind":"subject_line_test"|"template_phrase_swap"|"routing_tweak"|"copy_edit","details":{}},
  "expected_lift":{"metric":"open_rate"|"click_rate"|"wechat_rate","delta_pp":0.0,"rationale":""},
  "weeks_to_evaluate":4, "skip_reason_if_no_proposal":null }
If no shippable change, set skip_reason_if_no_proposal. JSON only.` },
];

async function runOnePersona(p: Persona, evidencePack: string, runningContext: string, loopName: string): Promise<string> {
  const userPrompt = `## ${loopName} — your role: ${p.display}
${p.question}

## Shared evidence pack
${evidencePack}
${runningContext ? "\n## What other panelists have said so far\n" + runningContext : ""}

200 words max. Cite specifics. Don't repeat others.`;
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: p.system,
      user: userPrompt,
      temperature: 0.5,
      max_tokens: p.key === "synthesizer" ? 1500 : 800,
    });
    return r.text?.trim() ?? "(empty)";
  } catch (err) {
    return `(persona errored: ${String(err).slice(0, 100)})`;
  }
}

interface RunOpts { dryRun?: boolean; }
interface WeeklyResult { proposalId?: string; title?: string; outcome: "proposal" | "skipped"; }

async function buildWeeklyEvidence(): Promise<string> {
  const lines: string[] = [];
  const constraints = await buildConstraintsPreamble();
  if (constraints) lines.push(constraints);

  lines.push(`## Week-over-week metrics (last 7d vs prior 7d)`);
  const now = Date.now(); const wk = 7 * 24 * 3600 * 1000;
  const cur7 = new Date(now - wk).toISOString();
  const prev14 = new Date(now - 2 * wk).toISOString();
  for (const [label, range] of [["last 7d", [cur7, undefined]], ["prior 7d", [prev14, cur7]]] as const) {
    let q = supabase.from("emails").select("id, status, created_at").gte("created_at", range[0]);
    if (range[1]) q = q.lt("created_at", range[1]);
    const { data } = await q;
    const sent = data?.length ?? 0;
    const opened = (data ?? []).filter((e: { status: string }) => e.status === "opened" || e.status === "clicked").length;
    const clicked = (data ?? []).filter((e: { status: string }) => e.status === "clicked").length;
    lines.push(`  ${label}: sent=${sent}, opened=${opened}, clicked=${clicked}`);
  }
  const { data: drifts } = await supabase
    .from("prompt_drift_patterns")
    .select("ai_phrase, sales_phrase, occurrence_count, status")
    .order("occurrence_count", { ascending: false }).limit(10);
  if (drifts && drifts.length > 0) {
    lines.push(`\n## Recent drift patterns`);
    for (const d of drifts) lines.push(`  [${d.status}] x${d.occurrence_count}  "${(d.ai_phrase || "").slice(0, 50)}" → "${(d.sales_phrase || "").slice(0, 50)}"`);
  }
  const { data: offers } = await supabase.from("jitr_offers").select("decision").gte("offered_at", cur7);
  const accepts = (offers ?? []).filter((o: { decision: string }) => o.decision === "accept").length;
  const dismisses = (offers ?? []).filter((o: { decision: string }) => o.decision === "dismiss").length;
  lines.push(`\n## JITR (Daily loop) — last 7d: accepts=${accepts}, dismisses=${dismisses}`);
  const { data: inbounds } = await supabase
    .from("inbound_emails").select("subject, body_snippet")
    .order("received_at", { ascending: false }).limit(8);
  if (inbounds && inbounds.length > 0) {
    lines.push(`\n## Recent inbound replies (Academic Proxy + Psychologist fodder)`);
    for (const i of inbounds) lines.push(`  "${(i.subject || "").slice(0, 60)}" — ${(i.body_snippet || "").slice(0, 100)}`);
  }
  return lines.join("\n");
}

export async function runWeeklyCongress(opts: RunOpts = {}): Promise<WeeklyResult> {
  const evidencePack = await buildWeeklyEvidence();
  const personas: Record<string, string> = {};
  let runningContext = "";
  for (const p of WEEKLY_ROSTER) {
    const text = await runOnePersona(p, evidencePack, runningContext, "Weekly Tactical Congress");
    personas[p.key] = text;
    runningContext += `\n\n### ${p.display}\n${text}`;
  }

  let synthJson: { title?: string; change_spec?: object; expected_lift?: object; weeks_to_evaluate?: number; skip_reason_if_no_proposal?: string | null };
  try {
    const raw = personas.synthesizer.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    synthJson = JSON.parse(raw);
  } catch {
    return { outcome: "skipped" };
  }

  if (synthJson.skip_reason_if_no_proposal) {
    if (!opts.dryRun) await notifyAdminText(`📋 Weekly Tactical Congress: no proposal.\n${synthJson.skip_reason_if_no_proposal}`);
    return { outcome: "skipped" };
  }

  if (opts.dryRun) return { outcome: "proposal", title: synthJson.title };

  const { data: row } = await supabase.from("tactical_proposals").insert({
    title: synthJson.title!,
    deliberation: { personas, change_spec: synthJson.change_spec, evidence_pack_excerpt: evidencePack.slice(0, 2000) },
    change_spec: synthJson.change_spec!,
    expected_lift: synthJson.expected_lift,
    weeks_to_evaluate: synthJson.weeks_to_evaluate ?? 4,
  }).select().single();
  if (!row) return { outcome: "skipped" };

  await notifyAdminText([
    `📋 Weekly Tactical Congress proposal`,
    ``,
    `Title: ${synthJson.title}`,
    `Expected lift: ${JSON.stringify(synthJson.expected_lift)}`,
    `Evaluate: ${synthJson.weeks_to_evaluate ?? 4} weeks`,
    ``,
    `Change spec: ${JSON.stringify(synthJson.change_spec).slice(0, 300)}`,
    ``,
    `Adversary: "${(personas.adversary || "").slice(0, 200)}"`,
    `Psychologist: "${(personas.psychologist || "").slice(0, 200)}"`,
    ``,
    `Approve: /api/tactical/${row.id}/decide?approved=1`,
    `Reject:  /api/tactical/${row.id}/decide?approved=0`,
  ].join("\n"));
  return { outcome: "proposal", proposalId: row.id, title: synthJson.title };
}

// Monthly + postmortem stubs that the cron routes call. Their full
// orchestration still lives in scripts/congress-monthly.ts and
// scripts/congress-postmortem.ts; the cron just re-invokes that
// orchestration in-process via dynamic import to avoid duplicating.
export async function runMonthlyCongress(opts: RunOpts = {}): Promise<{ ok: boolean }> {
  // For now: log only. The full Loop 3 lives in scripts/congress-monthly.ts
  // and is operator-triggered. Cron entry is a placeholder so we don't
  // forget the cadence — uncomment the import below to enable.
  void opts;
  await notifyAdminText("📅 Monthly Strategic Congress placeholder fired (full impl in scripts/congress-monthly.ts; run manually for now)");
  return { ok: true };
}

export async function runPostmortemDetector(opts: RunOpts = {}): Promise<{ ok: boolean; fired: boolean }> {
  // Detection-only path. The forensic congress runs from scripts/
  // when triggered. Here we just check the breach condition.
  void opts;
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const cur14 = new Date(now - 14 * day).toISOString();
  const prior74 = new Date(now - 74 * day).toISOString();
  async function rate(start: string, end?: string) {
    let q1 = supabase.from("emails").select("id", { count: "exact", head: true }).gte("created_at", start);
    let q2 = supabase.from("brief_lookups").select("id", { count: "exact", head: true }).gte("marked_at", start);
    if (end) { q1 = q1.lt("created_at", end); q2 = q2.lt("marked_at", end); }
    const { count: sent } = await q1;
    const { count: convs } = await q2;
    return { sent: sent ?? 0, convs: convs ?? 0, rate: sent ? (convs ?? 0) / sent : 0 };
  }
  const recent = await rate(cur14);
  const baseline = await rate(prior74, cur14);
  const dropPct = baseline.rate > 0 ? (1 - recent.rate / baseline.rate) * 100 : 0;
  if (dropPct > 20 && recent.sent > 50) {
    await notifyAdminText(`🚨 Postmortem trigger: conversion dropped ${dropPct.toFixed(1)}% (baseline ${(baseline.rate * 100).toFixed(2)}% → recent ${(recent.rate * 100).toFixed(2)}%). Run: npx tsx scripts/congress-postmortem.ts`);
    return { ok: true, fired: true };
  }
  return { ok: true, fired: false };
}
