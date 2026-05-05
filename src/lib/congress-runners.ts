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

  // Geo split — domestic .cn vs overseas. Same dataset surfaced on /analysis.
  // Two-stage funnel makes the audience-difference legible to every persona.
  try {
    const { computeSegmentFunnels } = await import("@/lib/segment-funnels");
    const f = await computeSegmentFunnels({ lookbackDays: 90 });
    const dim = f.dimensions.find((d) => d.dimension === "geo_binary");
    const dom = dim?.segments.find((s) => s.segment === "Domestic (.cn)");
    const ovs = dim?.segments.find((s) => s.segment === "Overseas");
    if (dom && ovs && dom.delivered + ovs.delivered > 0) {
      lines.push(`## Geo split (last 90d, domestic .cn vs overseas)`);
      lines.push(`  Domestic .cn: delivered=${dom.delivered}, ctr=${(dom.ctr * 100).toFixed(1)}%, post-click conv=${(dom.postClickConv * 100).toFixed(1)}%`);
      lines.push(`  Overseas    : delivered=${ovs.delivered}, ctr=${(ovs.ctr * 100).toFixed(1)}%, post-click conv=${(ovs.postClickConv * 100).toFixed(1)}%`);
      const ctrRatio = dom.ctr > 0 ? ovs.ctr / dom.ctr : 0;
      const convRatio = ovs.postClickConv > 0 ? dom.postClickConv / ovs.postClickConv : 0;
      lines.push(`  Ratio: overseas clicks ${ctrRatio.toFixed(2)}× domestic, but domestic converts ${convRatio.toFixed(2)}× overseas once clicked.`);
    }
  } catch (err) {
    console.error("[congress] geo split for evidence pack failed", err);
  }

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

// ── Loop 3: Monthly Strategic Congress ─────────────────────────────────
//
// Different roster: Historian (grades Loop 2 outputs), Funnel Economist,
// Constituent Advocate, Psychologist, Adversary, Synthesizer.
// Output: 0-1 strategic_decisions row + (if approved) a strategic_directive.

const MONTHLY_ROSTER: Persona[] = [
  { key: "historian", display: "Historian",
    system: "你是 Historian — 专门 grade 过去 90 天 tactical congress 通过的决定. 比较 expected_lift 和 actual_lift. 不留情面.",
    question: "Read the graded tactical proposals in the evidence pack. For each: one-line verdict (hit / partial / miss / inconclusive) with the numbers. Then one sentence on the quarter's net trajectory." },
  { key: "funnel_economist", display: "Funnel Economist",
    system: "你是 funnel economist — 看整个漏斗 as a unit. 找 actual bottleneck.",
    question: "Which funnel stage is actually the bottleneck right now? If you had to pick ONE stage to attack next quarter, which and why?" },
  { key: "constituent_advocate", display: "Constituent Advocate",
    system: "你 speaks for both researcher AND rep as humans. 关心 long-term trust + experience.",
    question: "Beyond metrics, what's degrading or improving in the human experience — for recipients AND reps? Cite specifics." },
  { key: "psychologist", display: "Psychologist",
    system: "你是 psychologist. 在 strategic horizon 上你关心 long-term trust + emotional capital.",
    question: "Looking at 90 days: are we building or eroding emotional capital with the Chinese AI research community? Are reps showing sustainable engagement or signs of mechanical script-running? What structural change would address the deepest psychological friction?" },
  { key: "adversary", display: "Adversary",
    system: "你 attack proposed STRATEGIC changes. Bigger swings, more skepticism.",
    question: "If the panel proposes a structural change (new category, threshold redefinition, kill a distinction, hire a 6th rep), what's the most likely failure mode? What evidence is missing?" },
  { key: "synthesizer", display: "Synthesizer",
    system: "你 synthesize the panel into a strategic decision. JSON output only.",
    question: `Produce JSON:
{ "title":"one-line summary or 'no change this month'",
  "outcome":"approved"|"rejected"|"deferred"|"no_proposal",
  "directive_body":"if approved — one-paragraph directive that constrains Loop 2",
  "rationale":"why",
  "historian_summary":"one-sentence grade of last quarter overall: net positive / net zero / net negative" }
JSON only, no markdown fence. Set max_tokens-friendly directive_body (under 800 chars).` },
];

async function gradeOverdueTacticals(): Promise<Array<{ id: string; title: string; expected: object; actual: object; grade: string }>> {
  const { data: due } = await supabase
    .from("tactical_proposals")
    .select("*")
    .eq("ship_decision", "approved")
    .is("graded_at", null)
    .lt("evaluation_due_at", new Date().toISOString());
  const graded: Array<{ id: string; title: string; expected: object; actual: object; grade: string }> = [];
  for (const p of due ?? []) {
    if (!p.shipped_at) continue;
    const startISO = p.shipped_at;
    const endISO = new Date(new Date(startISO).getTime() + (p.weeks_to_evaluate ?? 4) * 7 * 24 * 3600 * 1000).toISOString();
    const { data: postEmails } = await supabase.from("emails").select("status").gte("created_at", startISO).lt("created_at", endISO);
    const sent = postEmails?.length ?? 0;
    const opened = (postEmails ?? []).filter((e: { status: string }) => e.status === "opened" || e.status === "clicked").length;
    const clicked = (postEmails ?? []).filter((e: { status: string }) => e.status === "clicked").length;
    const exp = p.expected_lift as { metric?: string; delta_pp?: number } | null;
    let grade: "hit" | "partial" | "miss" | "inconclusive" = "inconclusive";
    if (sent < 30) grade = "inconclusive";
    else if (exp?.metric === "open_rate" && exp?.delta_pp != null) {
      const baseStart = new Date(new Date(startISO).getTime() - 28 * 24 * 3600 * 1000).toISOString();
      const { data: baseEmails } = await supabase.from("emails").select("status").gte("created_at", baseStart).lt("created_at", startISO);
      const baseSent = baseEmails?.length ?? 0;
      const baseOpened = (baseEmails ?? []).filter((e: { status: string }) => e.status === "opened" || e.status === "clicked").length;
      const baseRate = baseSent > 0 ? baseOpened / baseSent : 0;
      const actualRate = sent > 0 ? opened / sent : 0;
      const actualDelta = (actualRate - baseRate) * 100;
      if (actualDelta >= exp.delta_pp * 0.8) grade = "hit";
      else if (actualDelta >= exp.delta_pp * 0.3) grade = "partial";
      else grade = "miss";
    }
    const actual = { sent, open_rate: sent > 0 ? opened / sent : 0, click_rate: sent > 0 ? clicked / sent : 0 };
    graded.push({ id: p.id, title: p.title, expected: exp ?? {}, actual, grade });
    await supabase.from("tactical_proposals").update({
      graded_at: new Date().toISOString(),
      actual_lift: actual,
      grade,
    }).eq("id", p.id);
  }
  return graded;
}

async function buildMonthlyEvidence(graded: Array<{ id: string; title: string; expected: object; actual: object; grade: string }>): Promise<string> {
  const lines: string[] = [];
  const constraints = await buildConstraintsPreamble();
  if (constraints) lines.push(constraints);

  lines.push(`## Last quarter's tactical proposals — graded`);
  if (graded.length === 0) lines.push(`(no proposals were due for grading this cycle)`);
  else for (const g of graded) {
    lines.push(`  [${g.grade}] "${g.title}"`);
    lines.push(`    expected: ${JSON.stringify(g.expected)}`);
    lines.push(`    actual:   ${JSON.stringify(g.actual)}`);
  }

  const start90 = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const { count: leadsScanned } = await supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).gte("created_at", start90);
  const { count: emailsSent } = await supabase.from("emails").select("*", { count: "exact", head: true }).gte("created_at", start90);
  const { count: wechatAdds } = await supabase.from("brief_lookups").select("*", { count: "exact", head: true }).gte("marked_at", start90);
  const { count: clickEventCount } = await supabase.from("webhook_events").select("*", { count: "exact", head: true }).eq("type", "email.clicked").gte("created_at", start90);
  lines.push(`\n## 90-day funnel rollup`);
  lines.push(`  arxiv leads scanned: ${leadsScanned ?? 0}`);
  lines.push(`  emails sent: ${emailsSent ?? 0}`);
  lines.push(`  click events: ${clickEventCount ?? 0}`);
  lines.push(`  wechat adds: ${wechatAdds ?? 0}`);
  if (emailsSent && wechatAdds) lines.push(`  send→wechat conversion: ${(100 * wechatAdds / emailsSent).toFixed(2)}%`);

  const { data: leadsByDir } = await supabase.from("pipeline_leads").select("research_direction, status").gte("created_at", start90);
  const dirTally = new Map<string, { sent: number; total: number }>();
  for (const l of leadsByDir ?? []) {
    const d = (l as { research_direction: string | null }).research_direction || "Other";
    if (!dirTally.has(d)) dirTally.set(d, { sent: 0, total: 0 });
    dirTally.get(d)!.total++;
    if ((l as { status: string }).status === "sent") dirTally.get(d)!.sent++;
  }
  lines.push(`\n## Per-direction send (last 90d, top 10)`);
  for (const [d, t] of [...dirTally].sort((a, b) => b[1].sent - a[1].sent).slice(0, 10)) lines.push(`  ${d}: sent=${t.sent}/${t.total}`);

  const { data: tpls } = await supabase.from("email_templates").select("name, rep_id").eq("active", true);
  lines.push(`\n## Active email templates: ${(tpls ?? []).map((t: { name: string }) => t.name).join(", ")}`);

  return lines.join("\n");
}

export async function runMonthlyCongress(opts: RunOpts = {}): Promise<{ ok: boolean; outcome?: string; decisionId?: string; gradedCount?: number }> {
  const graded = await gradeOverdueTacticals();
  const evidencePack = await buildMonthlyEvidence(graded);

  const personas: Record<string, string> = {};
  let runningContext = "";
  for (const p of MONTHLY_ROSTER) {
    const text = await runOnePersona(p, evidencePack, runningContext, "Monthly Strategic Congress");
    personas[p.key] = text;
    runningContext += `\n\n### ${p.display}\n${text}`;
  }

  let synthJson: { title?: string; outcome?: string; directive_body?: string; rationale?: string; historian_summary?: string };
  try {
    const raw = personas.synthesizer.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    synthJson = JSON.parse(raw);
  } catch {
    if (!opts.dryRun) {
      await notifyAdminText(`📅 Monthly Strategic Congress: synthesizer JSON parse failed. Raw: ${personas.synthesizer?.slice(0, 400)}`);
    }
    return { ok: false, outcome: "parse_failed" };
  }

  if (opts.dryRun) {
    return { ok: true, outcome: synthJson.outcome, gradedCount: graded.length };
  }

  const { data: decRow } = await supabase.from("strategic_decisions").insert({
    title: synthJson.title || "(untitled)",
    deliberation: { personas, graded_proposals: graded, evidence_pack_excerpt: evidencePack.slice(0, 3000) },
    outcome: ["approved", "rejected", "deferred"].includes(synthJson.outcome ?? "") ? synthJson.outcome : "deferred",
  }).select().single();
  if (!decRow) return { ok: false };

  let directiveId: string | null = null;
  if (synthJson.outcome === "approved" && synthJson.directive_body) {
    const { data: dirRow } = await supabase.from("strategic_directives").insert({
      body: synthJson.directive_body,
      source_decision_id: decRow.id,
      notes: synthJson.rationale,
    }).select().single();
    if (dirRow) {
      directiveId = dirRow.id;
      await supabase.from("strategic_decisions").update({ resulting_directive_id: dirRow.id }).eq("id", decRow.id);
    }
  }

  await notifyAdminText([
    `🏛️ Monthly Strategic Congress`,
    ``,
    `Outcome: ${synthJson.outcome}`,
    `Title: ${synthJson.title}`,
    `Historian's grade: ${synthJson.historian_summary || "(no summary)"}`,
    `Graded ${graded.length} tactical proposals: ${graded.map((g) => g.grade).join(", ") || "(none due)"}`,
    ``,
    synthJson.directive_body ? `Active directive (constrains Loop 2):\n${synthJson.directive_body.slice(0, 400)}` : "(no new directive)",
    ``,
    `Adversary: "${(personas.adversary || "").slice(0, 200)}"`,
    `Psychologist: "${(personas.psychologist || "").slice(0, 200)}"`,
    `decision_id=${decRow.id}${directiveId ? ` directive_id=${directiveId}` : ""}`,
  ].join("\n"));

  return { ok: true, outcome: synthJson.outcome, decisionId: decRow.id, gradedCount: graded.length };
}

// ── Loop 1: JITR (Daily Apprentice) ────────────────────────────────────
//
// Ports scripts/jitr-tick.mjs into the runner lib so cron can fire it.
// Same logic: pending drift patterns → attribute to dominant rep →
// send Lark interactive card → record jitr_offers row.

const JITR_ATTRIBUTION_THRESHOLD = 0.6;
const JITR_REOFFER_DAYS = 14;
const ADMIN_REP_ID = 5;

async function getLarkTokenAndBase(): Promise<{ token: string; base: string } | null> {
  const appId = process.env.LARK_APP_ID;
  const secret = process.env.LARK_APP_SECRET;
  if (!appId || !secret) return null;
  const base = process.env.LARK_REGION === "cn"
    ? "https://open.feishu.cn/open-apis"
    : "https://open.larksuite.com/open-apis";
  const res = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: secret }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (j.code !== 0) return null;
  return { token: j.tenant_access_token, base };
}

async function sendJitrCard(token: string, base: string, openId: string, repName: string, pattern: { ai_phrase: string; sales_phrase: string; occurrence_count: number; offerId: string }): Promise<string | null> {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `📝 一个小调整想法 - ${repName}`, tag: "plain_text" },
      template: "blue",
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `早. 我注意到最近 **${pattern.occurrence_count} 次** 你把这段:\n\n> ${pattern.ai_phrase}\n\n改成了这样:\n\n> ${pattern.sales_phrase}\n\n我可以把这条规则只加到 **你自己** 的草稿模板里, 以后自动这样写. 别的 rep 不受影响.` } },
      { tag: "action", actions: [
        { tag: "button", text: { tag: "plain_text", content: "好, 加到我的模板" }, type: "primary",
          value: { jitr_action: "accept", offer_id: pattern.offerId } },
        { tag: "button", text: { tag: "plain_text", content: "算了, 那次是临时" }, type: "default",
          value: { jitr_action: "dismiss", offer_id: pattern.offerId } },
      ] },
      { tag: "note", elements: [{ tag: "plain_text", content: "如果加了之后效果不好, 系统会自动回滚 + 通知你." }] },
    ],
  };
  const res = await fetch(`${base}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) return null;
  return j.data?.message_id ?? null;
}

export async function runJitrTick(opts: RunOpts = {}): Promise<{ ok: boolean; offered: number; skipped: number; unboundReps: string[] }> {
  const { data: patterns } = await supabase
    .from("prompt_drift_patterns")
    .select("*")
    .eq("status", "pending")
    .gte("occurrence_count", 2)
    .order("occurrence_count", { ascending: false });

  const { data: reps } = await supabase.from("sales_reps").select("id, name, lark_open_id, active").eq("active", true);
  const repById = new Map((reps ?? []).map((r: { id: number }) => [r.id, r] as const));
  const adminRep = repById.get(ADMIN_REP_ID) as { lark_open_id?: string } | undefined;

  type Offered = { pattern: { id: number; ai_phrase: string; sales_phrase: string; occurrence_count: number }; rep: { id: number; name: string; lark_open_id: string }; offerId?: string };
  const offered: Offered[] = [];
  const skipped: Array<{ patternId: number; reason: string }> = [];
  const unboundReps = new Set<string>();

  for (const p of patterns ?? []) {
    const exampleIds = (p.example_lead_ids || []).filter((s: unknown) => typeof s === "string" && (s as string).length > 0) as string[];
    if (exampleIds.length === 0) { skipped.push({ patternId: p.id, reason: "no example_lead_ids" }); continue; }

    const fullIds = exampleIds.filter((s) => s.length >= 36);
    const prefixIds = exampleIds.filter((s) => s.length < 36);
    const repCounts = new Map<number, number>();
    if (fullIds.length > 0) {
      const { data: leads } = await supabase.from("pipeline_leads").select("assigned_rep_id").in("id", fullIds);
      for (const l of leads ?? []) {
        const rid = (l as { assigned_rep_id: number | null }).assigned_rep_id;
        if (rid != null) repCounts.set(rid, (repCounts.get(rid) ?? 0) + 1);
      }
    }
    for (const prefix of prefixIds) {
      const { data: leads } = await supabase.from("pipeline_leads").select("assigned_rep_id").like("id", `${prefix}%`).limit(5);
      for (const l of leads ?? []) {
        const rid = (l as { assigned_rep_id: number | null }).assigned_rep_id;
        if (rid != null) repCounts.set(rid, (repCounts.get(rid) ?? 0) + 1);
      }
    }
    const total = [...repCounts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) { skipped.push({ patternId: p.id, reason: "no leads resolvable" }); continue; }

    const sorted = [...repCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [topRepId, topCount] = sorted[0];
    if (topCount / total < JITR_ATTRIBUTION_THRESHOLD) {
      skipped.push({ patternId: p.id, reason: `multi-rep (top ${topCount}/${total})` });
      continue;
    }
    const rep = repById.get(topRepId) as { id: number; name: string; lark_open_id: string | null } | undefined;
    if (!rep) { skipped.push({ patternId: p.id, reason: `rep_id=${topRepId} not active` }); continue; }
    if (!rep.lark_open_id) {
      unboundReps.add(rep.name);
      skipped.push({ patternId: p.id, reason: `${rep.name} not bound to Lark` });
      continue;
    }

    const cutoff = new Date(Date.now() - JITR_REOFFER_DAYS * 24 * 3600 * 1000).toISOString();
    const { data: prior } = await supabase
      .from("jitr_offers")
      .select("id")
      .eq("pattern_id", p.id)
      .eq("rep_id", rep.id)
      .gte("offered_at", cutoff)
      .limit(1);
    if (prior && prior.length > 0) {
      skipped.push({ patternId: p.id, reason: `already offered to ${rep.name} within ${JITR_REOFFER_DAYS}d` });
      continue;
    }

    offered.push({
      pattern: { id: p.id, ai_phrase: p.ai_phrase, sales_phrase: p.sales_phrase, occurrence_count: p.occurrence_count },
      rep: { id: rep.id, name: rep.name, lark_open_id: rep.lark_open_id },
    });
  }

  if (opts.dryRun) {
    return { ok: true, offered: offered.length, skipped: skipped.length, unboundReps: [...unboundReps] };
  }

  // Insert offer rows + send cards
  const tokenInfo = await getLarkTokenAndBase();
  if (!tokenInfo && offered.length > 0) {
    return { ok: false, offered: 0, skipped: skipped.length, unboundReps: [...unboundReps] };
  }
  let sentCount = 0;
  for (const o of offered) {
    const { data: row } = await supabase.from("jitr_offers").insert({
      pattern_id: o.pattern.id,
      rep_id: o.rep.id,
      ai_phrase: o.pattern.ai_phrase,
      sales_phrase: o.pattern.sales_phrase,
      occurrence_count: o.pattern.occurrence_count,
    }).select().single();
    if (!row) continue;
    o.offerId = row.id;
    if (tokenInfo) {
      const messageId = await sendJitrCard(tokenInfo.token, tokenInfo.base, o.rep.lark_open_id, o.rep.name, { ...o.pattern, offerId: row.id });
      if (messageId) {
        await supabase.from("jitr_offers").update({ card_message_id: messageId }).eq("id", row.id);
        sentCount++;
      }
    }
  }

  // Admin digest
  if (adminRep?.lark_open_id) {
    const lines: string[] = [];
    lines.push(`📊 JITR daily — ${new Date().toISOString().slice(0, 10)}`);
    lines.push(`offered: ${sentCount}  skipped: ${skipped.length}`);
    if (offered.length > 0) {
      lines.push(``, `sent to:`);
      for (const o of offered) lines.push(`  • ${o.rep.name} ← "${o.pattern.ai_phrase.slice(0, 30)}…" → "${o.pattern.sales_phrase.slice(0, 30)}…"`);
    }
    if (unboundReps.size > 0) {
      lines.push(``, `⚠️ unbound reps (Lark open_id missing) — they're missing JITR offers:`);
      for (const n of unboundReps) lines.push(`  • ${n}`);
      lines.push(`fix: have them DM the bot once, then bind via /api/lark/bind`);
    }
    await notifyAdminText(lines.join("\n"));
  }

  return { ok: true, offered: sentCount, skipped: skipped.length, unboundReps: [...unboundReps] };
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
