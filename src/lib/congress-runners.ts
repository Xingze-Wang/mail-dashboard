// Shared congress-loop runners. Used by both the standalone scripts
// (npx tsx scripts/congress-*.ts) and the Vercel cron API routes.
// Keeping the orchestration here means we never have two copies of
// the persona logic drifting.

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";
import { notifyAdminText, buildConstraintsPreamble } from "@/lib/congress";
import { formatRateWithCI, MIN_RELIABLE_N, compareProportions } from "@/lib/wilson";

interface Persona { key: string; display: string; system: string; question: string; }

// Exported so the stepwise runner can pick the same roster and have
// inspections show identical persona keys regardless of which path
// drove the deliberation.
export const WEEKLY_ROSTER: Persona[] = [
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
    system: `你是 evidence-bound adversary. 不是单纯反对 — 是 *用证据* 挑战 panel 的结论.

规则:
1. 看 panel 之前给出的每一个 numeric claim.
2. 只挑战那些 *没有 statistical 支撑* 的 claim — 也就是 sample-size 太小 (n<${MIN_RELIABLE_N}) 或者两个 segment CI 重叠的判断.
3. 做反例时一定 cite a specific counter-data point from the evidence pack (e.g. "你说 Fudan 转化 0%, 但 SJTU 在 same tier same geo 同样 volume 下转化是 X% [CI: ...] — 这两个 CI 不重叠, 那为什么 Fudan 是 systemic 问题, 而不是 sample 问题?").
4. 如果你的反例需要 evidence pack 里没有的数据, 明确说 "我需要 X 数据来反驳但 pack 里没有, 这意味着 panel 这条 claim 本身也没有 cited evidence".

不要做无 evidence 的纯反对. 没东西可挑战时, 直接说 "这 round 没有可挑战的 small-sample claim".`,
    question: `Walk through the panel's numeric claims. Apply the rules above. Cite specific n / CI / similar-context comparisons from the evidence pack to support your challenges. Don't fabricate.` },
  { key: "synthesizer", display: "Synthesizer",
    system: "你 synthesizes the panel into a concrete shippable proposal. JSON output only.",
    question: `Produce JSON:
{
  "title":"one-line",
  "change_spec":{"kind":"subject_line_test"|"template_phrase_swap"|"routing_tweak"|"copy_edit","details":{}},
  "expected_lift":{"metric":"open_rate"|"click_rate"|"wechat_rate","delta_pp":0.0,"rationale":""},
  "weeks_to_evaluate":4,
  "skip_reason_if_no_proposal":null,
  "team_focus": {
    "theme": "短句 e.g. '本周聚焦 cn-tier1 转化'",
    "rationale": "1-2 句, 引用 evidence pack 里的具体数据"
  },
  "weekly_missions": [
    {"rep_kind": "all_sales", "kind": "send", "daily_target": 8,
     "scope": {"segment": "cn"}, "description": "短句"},
    {"rep_kind": "all_sales", "kind": "reply", "daily_target": 3, "description": "回复 inbound"},
    {"rep_kind": "admin",    "kind": "review_proposals", "daily_target": 1}
  ]
}
weekly_missions 是给整个团队的本周 daily mission 模板. 系统会把它 instantiate 给每个 rep, 每个工作日一份.
"rep_kind": "all_sales" = 所有 active 销售; "admin" = 管理员; "rep:N" = 特定 rep_id.
"kind" 必须 ∈ ["send", "reply", "mark_wechat", "review_proposals", "review_template_edits", "custom"].
daily_target 是每个工作日的目标, 不是一周总和.
如果 evidence pack 里 sample 太少, team_focus 和 weekly_missions 都可以省略 (设成 null).
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

export async function buildWeeklyEvidence(): Promise<string> {
  const lines: string[] = [];
  const constraints = await buildConstraintsPreamble();
  if (constraints) lines.push(constraints);

  // ─── Sample-size discipline header ───────────────────────────────────
  // Tells personas explicitly: don't draw conclusions from small samples.
  // Every numeric line below this point gets a Wilson 95% CI annotation
  // with a "too few to call" tag when n < MIN_RELIABLE_N. Personas should
  // refuse to call something a problem when its CI is wide enough that
  // 0% and the population mean both sit inside it.
  lines.push(`## ⚠️ Sample-size discipline (READ FIRST)`);
  lines.push(`所有 rate-style 数据都附了 95% Wilson CI 和 n. 规则:`);
  lines.push(`  - 如果一个 segment 标了 "too few to call" (n<${MIN_RELIABLE_N}), 不要做"X 转化率 0%"或"X 表现差"的判断.`);
  lines.push(`  - 两个 segment 比较时, 看他们 CI 是否 *不重叠*. 重叠就是 "可能一样, 可能不同, 没法确定".`);
  lines.push(`  - "Fudan 0% 转化" 在 n=5 的时候和 "我们对 Fudan 还没数据" 是一回事.`);
  lines.push(``);

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
      // Treat ctr as clicks/delivered. Recover counts from rate*delivered
      // since the funnel returns ratios. Round to nearest int (the funnel
      // store rounds these already; this is just defensive).
      const domClicks = Math.round(dom.ctr * dom.delivered);
      const ovsClicks = Math.round(ovs.ctr * ovs.delivered);
      lines.push(`  Domestic .cn: ctr = ${formatRateWithCI(domClicks, dom.delivered)}`);
      lines.push(`  Overseas    : ctr = ${formatRateWithCI(ovsClicks, ovs.delivered)}`);
      // Wilson-aware comparison: only declare a difference if the CIs
      // don't overlap. This is what the adversary will look at.
      const cmp = compareProportions(domClicks, dom.delivered, ovsClicks, ovs.delivered);
      if (cmp.verdict === "inconclusive") {
        lines.push(`  → 两边 CTR CI 重叠, 差异在 95% 置信下 *没有 statistical 支撑*.`);
      } else {
        lines.push(`  → ${cmp.verdict === "a_higher" ? "Domestic" : "Overseas"} ctr is statistically higher (CIs separate).`);
      }
    }
  } catch (err) {
    console.error("[congress] geo split for evidence pack failed", err);
  }

  lines.push(`\n## Week-over-week metrics (last 7d vs prior 7d)`);
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
    // Annotate open + click rates with CI so personas don't compare
    // 5/100 vs 4/95 as if the difference were real.
    lines.push(`  ${label}: sent=${sent}, open rate=${formatRateWithCI(opened, sent)}, click rate=${formatRateWithCI(clicked, sent)}`);
  }

  // ─── Per-school slice (adversary needs this) ─────────────────────────
  // Pull top schools by send volume. Every school gets a Wilson CI on its
  // ctr. We surface this slice so the adversary persona can call out
  // "Fudan 0% but Tsinghua 5% with similar volume" when defensible, and
  // refuse to make per-school claims when the CIs all overlap.
  try {
    const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const { data: emailsRaw } = await supabase
      .from("emails")
      .select("id, status, lead_id, created_at")
      .gte("created_at", since90)
      .limit(5000);
    const emails = emailsRaw ?? [];
    const leadIds = [...new Set(emails.map((e) => e.lead_id).filter(Boolean))] as string[];
    const leadSchool = new Map<string, string>();
    if (leadIds.length > 0) {
      const CHUNK = 150;
      for (let i = 0; i < leadIds.length; i += CHUNK) {
        const slice = leadIds.slice(i, i + CHUNK);
        const { data: leads } = await supabase
          .from("pipeline_leads")
          .select("id, school_name")
          .in("id", slice);
        for (const l of leads ?? []) {
          if (l.school_name) leadSchool.set(l.id as string, l.school_name as string);
        }
      }
    }
    const bySchool = new Map<string, { sent: number; clicked: number }>();
    for (const e of emails) {
      const school = leadSchool.get(e.lead_id as string);
      if (!school) continue;
      const cur = bySchool.get(school) ?? { sent: 0, clicked: 0 };
      cur.sent++;
      if (e.status === "clicked") cur.clicked++;
      bySchool.set(school, cur);
    }
    // Sort by send volume desc, take top 12. Personas can spot
    // similar-volume pairs for cross-comparison without being
    // overwhelmed by a long tail of n=1 rows.
    const ranked = [...bySchool.entries()]
      .sort((a, b) => b[1].sent - a[1].sent)
      .slice(0, 12);
    if (ranked.length > 0) {
      lines.push(`\n## Per-school CTR slice (last 90d, top 12 by volume)`);
      lines.push(`  注: 大部分 schools 的 n 不够大. 不要单独看一个 school 下结论. 看相似 volume 的 schools 之间 CI 是否分离.`);
      for (const [school, s] of ranked) {
        lines.push(`  ${school.padEnd(36)}: ${formatRateWithCI(s.clicked, s.sent)}`);
      }
    }
  } catch (err) {
    console.error("[congress] per-school slice failed", err);
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

  // ─── Recent rejected proposals — DO NOT re-propose this kind ────
  // When admin rejects a proposal with /api/templates/[id]/reject
  // (mig 076), the reason gets stored. Surfacing those reasons here
  // teaches synthesizer not to re-propose the same kind of change.
  // Without this, congress would loop through the same rejected
  // ideas every week.
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: rejected } = await supabase
    .from("email_templates")
    .select("name, proposed_evidence, rejection_reason, rejected_at")
    .eq("status", "archived")
    .not("rejection_reason", "is", null)
    .gte("rejected_at", since30)
    .order("rejected_at", { ascending: false })
    .limit(15);
  if (rejected && rejected.length > 0) {
    lines.push(`\n## ⚠️ Recently rejected proposals (last 30d) — DO NOT re-propose this kind`);
    lines.push(`Admin rejected these with explicit reasons. If the synthesizer is about to propose anything that looks like one of these, STOP and pivot — admin already said no with a specific reason.`);
    for (const r of rejected) {
      const slot = (r.proposed_evidence as { slot_swapped?: string } | null)?.slot_swapped;
      lines.push(`  • [${r.rejected_at?.slice(0, 10) ?? '?'}] ${slot ? '(' + slot + ') ' : ''}${(r.name || '').slice(0, 50)}`);
      lines.push(`    Why rejected: ${(r.rejection_reason || '').slice(0, 300)}`);
    }
  }

  // ─── Admin in-thread feedback on proposals (mig 080) ───────────────
  // The /congress/proposals/[id]/review surface lets admins push back
  // on individual proposals with specific text ("tone too aggressive"
  // / "we already tried this in March"). Surfacing those replies here
  // tells the synthesizer what to AVOID this round, even before the
  // proposal is formally rejected.
  try {
    const { data: feedback } = await supabase
      .from("proposal_feedback")
      .select("body, created_at, template_proposal_id")
      .gte("created_at", since30)
      .order("created_at", { ascending: false })
      .limit(20);
    if (feedback && feedback.length > 0) {
      lines.push(`\n## 📝 Admin in-thread feedback on recent proposals (last 30d)`);
      lines.push(`Admin left these comments on individual proposals — they're iterative ("close but…") rather than terminal rejections. Use them as fine-grained signals: if admin said "tone is too aggressive" on one proposal, don't re-propose anything aggressive.`);
      for (const f of feedback) {
        lines.push(`  • [${(f.created_at as string).slice(0, 10)}] on proposal ${(f.template_proposal_id as string).slice(0, 8)}: "${(f.body as string).slice(0, 280)}"`);
      }
    }
  } catch {/* table may not exist on older DBs */}

  // ─── Sales rep reactions to last week's proposals ──────────────────
  // /api/cron/congress-chime pushes a chime-in to every rep on Monday
  // 07:30 UTC asking "Congress proposed X — does this match what you've
  // seen?" When the rep replies via POST /api/help/chime-in {reply}, the
  // text lands in helper_chime_in_log.payload.reply_text. Surfacing those
  // here gives the synthesizer ground-truth from people doing the work,
  // not just the LLM personas debating in a vacuum.
  const { data: repFeedback } = await supabase
    .from("helper_chime_in_log")
    .select("rep_id, payload, pushed_at")
    .eq("kind", "congress_proposal_review")
    .eq("outcome", "replied")
    .gte("pushed_at", since30)
    .order("pushed_at", { ascending: false })
    .limit(15);
  if (repFeedback && repFeedback.length > 0) {
    lines.push(`\n## 💬 Sales rep feedback on last week's proposals`);
    lines.push(`Reps were asked "does this proposal match what you've seen?" These are their actual replies. Trust them — they're the ones writing emails. If a rep says "I tried this and it didn't work", weight that heavier than persona speculation.`);
    for (const r of repFeedback) {
      const p = r.payload as { top_title?: string; reply_text?: string };
      lines.push(`  • Rep ${r.rep_id} on "${p.top_title ?? '?'}": ${(p.reply_text ?? '').slice(0, 300)}`);
    }
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

  let synthJson: {
    title?: string;
    change_spec?: object;
    expected_lift?: object;
    weeks_to_evaluate?: number;
    skip_reason_if_no_proposal?: string | null;
    team_focus?: { theme?: string; rationale?: string } | null;
    weekly_missions?: Array<{
      rep_kind?: string;     // 'all_sales' | 'admin' | 'rep:N'
      kind?: string;
      daily_target?: number;
      scope?: Record<string, unknown>;
      description?: string;
    }>;
  };
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

  // ─── Template-prose fan-out ─────────────────────────────────────────
  // If the synthesizer's change_spec is a template-paragraph kind, run
  // it through the strategist + editor pipeline to produce actual
  // Chinese prose, then insert into email_templates as status='proposal'.
  // The tactical_proposals row is the deliberation/history record;
  // the email_templates row is the renderable, A/B-testable artifact.
  // Linked via tactical_proposal_id in proposed_evidence.
  let templateProposalId: string | null = null;
  let templateProposalNote = "";
  const spec = synthJson.change_spec as { kind?: string; details?: Record<string, unknown> } | undefined;
  const isTemplateKind =
    spec?.kind === "template_phrase_swap" ||
    spec?.kind === "subject_line_test" ||
    spec?.kind === "subject_line" ||
    spec?.kind === "email_content" ||
    spec?.kind === "copy_edit";
  if (isTemplateKind) {
    try {
      const { craftAndGateProposal, inferSlotFromDescription } = await import("@/lib/template-prose-pipeline");
      const detailsStr = JSON.stringify(spec?.details ?? {});
      const segmentRaw = (spec?.details as { segment?: string } | undefined)?.segment;
      const segment = typeof segmentRaw === "string" ? segmentRaw : null;
      // For subject_line kinds, force the subject_format slot.
      const slot = (spec?.kind === "subject_line" || spec?.kind === "subject_line_test")
        ? "subject_format" as const
        : inferSlotFromDescription(`${synthJson.title} ${detailsStr}`);
      const crafted = await craftAndGateProposal({
        hypothesis: synthJson.title!,
        reasoning: detailsStr,
        proposed_test: detailsStr,
        segment,
        slot,
        proposedBy: "congress",
        evidence: {
          source: "weekly_congress",
          adversary_take: (personas.adversary ?? "").slice(0, 400),
          psychologist_take: (personas.psychologist ?? "").slice(0, 400),
        },
        tacticalProposalId: row.id as string,
      });
      if (crafted.ok) {
        templateProposalId = crafted.templateId;
        templateProposalNote = `\n📝 Template proposal drafted: ${crafted.name}`;
      } else {
        templateProposalNote = `\n⚠️ Template prose draft blocked: ${crafted.error}`;
      }
    } catch (e) {
      templateProposalNote = `\n⚠️ Template prose pipeline errored: ${(e as Error).message.slice(0, 200)}`;
    }
  }

  // ─── Mission system: persist team_focus + weekly_missions as proposed ─
  // The synthesizer optionally emits these. Admin approves them via
  // /admin/missions; only on approval do they go status=active and
  // become visible to reps on /missions.
  let missionNote = "";
  try {
    const focus = synthJson.team_focus;
    const missions = synthJson.weekly_missions ?? [];

    // Compute Monday of next week — we generate ahead so admin has
    // the weekend to approve.
    const now = new Date();
    const daysUntilNextMonday = ((1 - now.getUTCDay() + 7) % 7) || 7;
    const nextMonday = new Date(now);
    nextMonday.setUTCDate(now.getUTCDate() + daysUntilNextMonday);
    const weekStarting = nextMonday.toISOString().slice(0, 10);

    let focusId: string | null = null;
    if (focus?.theme) {
      const { data: focusRow } = await supabase
        .from("team_focus")
        .insert({
          week_starting: weekStarting,
          theme: focus.theme,
          rationale: focus.rationale ?? null,
          set_by: "congress",
          status: "proposed",
        })
        .select("id")
        .single();
      focusId = focusRow?.id as string | null;
    }

    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, role, active")
      .eq("active", true);
    const salesIds = (reps ?? []).filter((r) => r.role === "sales").map((r) => r.id as number);
    const adminIds = (reps ?? []).filter((r) => r.role === "admin").map((r) => r.id as number);

    const resolveRepKind = (kind: string): number[] => {
      if (kind === "all_sales") return salesIds;
      if (kind === "admin") return adminIds;
      const m = /^rep:(\d+)$/.exec(kind);
      if (m) return [parseInt(m[1], 10)];
      return [];
    };

    const VALID_KINDS = new Set([
      "send", "reply", "mark_wechat",
      "review_proposals", "review_template_edits", "custom",
    ]);
    const missionRows: Array<Record<string, unknown>> = [];
    for (const m of missions) {
      if (!m.kind || !VALID_KINDS.has(m.kind)) continue;
      const target = m.daily_target;
      if (typeof target !== "number" || target <= 0) continue;
      const repIds = resolveRepKind(m.rep_kind ?? "all_sales");
      for (const rid of repIds) {
        // Mon-Fri = 5 weekdays. Sat/Sun skipped (sales is M-F).
        for (let d = 0; d < 5; d++) {
          const due = new Date(nextMonday);
          due.setUTCDate(nextMonday.getUTCDate() + d);
          missionRows.push({
            rep_id: rid,
            due_date: due.toISOString().slice(0, 10),
            kind: m.kind,
            target,
            scope: m.scope ?? {},
            description: m.description ?? null,
            generated_by: "congress",
            team_focus_id: focusId,
            status: "proposed",
          });
        }
      }
    }

    if (missionRows.length > 0) {
      const { error: insErr } = await supabase.from("missions").insert(missionRows);
      if (insErr) {
        missionNote = `\n⚠️ Mission persist failed: ${insErr.message.slice(0, 100)}`;
      } else {
        const repCount = new Set(missionRows.map((r) => r.rep_id)).size;
        missionNote = `\n📅 Proposed week ${weekStarting}: ${missionRows.length} missions across ${repCount} reps`;
      }
    } else if (focusId) {
      missionNote = `\n📅 Proposed week ${weekStarting} team_focus only (no per-rep missions emitted)`;
    }
  } catch (e) {
    missionNote = `\n⚠️ Mission system errored: ${(e as Error).message.slice(0, 200)}`;
  }

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
    templateProposalNote,
    missionNote,
    ``,
    `Approve: /api/tactical/${row.id}/decide?approved=1`,
    `Reject:  /api/tactical/${row.id}/decide?approved=0`,
    templateProposalId ? `Preview prose: /templates/${templateProposalId}/inspect` : "",
    missionNote ? `Approve missions: /admin/missions` : "",
  ].filter(Boolean).join("\n"));
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
    system: `你 attack proposed STRATEGIC changes — bigger swings, more skepticism — but 仍然是 evidence-bound.

规则:
1. 看 panel 提议的 structural change. 找它依赖的 numeric claims.
2. 只挑战那些没有 statistical 支撑 (n<${MIN_RELIABLE_N}) 或者 CIs overlap 的 claim. Strategic 决定如果 sample 不够大就不该做.
3. Cite a specific counter-data point or counter-example. e.g. "panel 提议 kill tier-3 schools 因为 0% 转化, 但 evidence pack 里 tier-3 的 n=12, CI 是 [0%, 26%], 这等于'我们对 tier-3 没数据', 不等于 '0%'."
4. 如果反例需要 pack 里没的数据, 明确指出, 这意味着 panel 也没有 cited evidence.

不做无证据的纯反对. 没东西可挑战时直接说 "这 round 没有可挑战的 unsupported strategic claim".`,
    question: `Walk through the panel's structural proposal. Apply the rules above. Cite n / CI / similar-context comparisons. Don't fabricate.` },
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
    // Paginate past 1000-row cap. Even though 4-week windows are
    // typically under 1000 emails today, larger weeks_to_evaluate
    // values (8-12wks for slower-converting metrics) would silently
    // truncate the historian's grading basis.
    const { paginateAll: _pa1 } = await import("@/lib/supabase-paginate");
    const postEmails = await _pa1<{ status: string }>(
      (from, to) => supabase.from("emails").select("status")
        .gte("created_at", startISO).lt("created_at", endISO).range(from, to),
    );
    const sent = postEmails.length;
    const opened = postEmails.filter((e) => e.status === "opened" || e.status === "clicked").length;
    const clicked = postEmails.filter((e) => e.status === "clicked").length;
    const exp = p.expected_lift as { metric?: string; delta_pp?: number } | null;
    let grade: "hit" | "partial" | "miss" | "inconclusive" = "inconclusive";
    if (sent < 30) grade = "inconclusive";
    else if (exp?.metric === "open_rate" && exp?.delta_pp != null) {
      const baseStart = new Date(new Date(startISO).getTime() - 28 * 24 * 3600 * 1000).toISOString();
      const baseEmails = await _pa1<{ status: string }>(
        (from, to) => supabase.from("emails").select("status")
          .gte("created_at", baseStart).lt("created_at", startISO).range(from, to),
      );
      const baseSent = baseEmails.length;
      const baseOpened = baseEmails.filter((e) => e.status === "opened" || e.status === "clicked").length;
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

  // Paginate past Supabase's silent 1000-row cap. At 1443+ leads in
  // 90d (Q2 2026 scale) a single .select() under-counted directions
  // by ~30%, leaking into monthly congress stats.
  const { paginateAll: paginateLeadsByDir } = await import("@/lib/supabase-paginate");
  const leadsByDir = await paginateLeadsByDir<{ research_direction: string | null; status: string }>(
    (from, to) => supabase.from("pipeline_leads")
      .select("research_direction, status")
      .gte("created_at", start90)
      .range(from, to),
  );
  const dirTally = new Map<string, { sent: number; total: number }>();
  for (const l of leadsByDir) {
    const d = l.research_direction || "Other";
    if (!dirTally.has(d)) dirTally.set(d, { sent: 0, total: 0 });
    dirTally.get(d)!.total++;
    if (l.status === "sent") dirTally.get(d)!.sent++;
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
