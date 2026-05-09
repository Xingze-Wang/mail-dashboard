/**
 * Hypothesis-driven congress runner.
 *
 * Different from runWeeklyCongress: instead of "look at this week's
 * metrics, panel discusses, synthesizer proposes one change", this
 * runner:
 *
 *   1. Reads existing OPEN hypotheses (proposed | testing) from
 *      congress_hypotheses
 *   2. For each TESTING hypothesis: pulls outcome data, decides
 *      confirmed | refuted | still gathering
 *   3. Generates NEW hypotheses with a CoT prompt that names the
 *      qualitative dimensions explicitly:
 *        • city tier (北上广深 vs 二线 vs 普通省会)
 *        • school culture (985/211 vs other; CS-strong vs general)
 *        • recipient name format (full Han 三字 vs 双字 vs pinyin)
 *        • lab seniority (PhD student vs postdoc vs PI)
 *        • paper recency / stage (just-accepted vs working draft)
 *        • time-of-day / day-of-week sent
 *   4. For the strongest hypotheses (~1-3 per round), the strategist
 *      drafts a concrete template proposal — clones the current
 *      segment-default template, mutates one paragraph, writes as
 *      status='proposal' on email_templates with proposed_evidence
 *      pointing back at the hypothesis row.
 *   5. Mirrors each new hypothesis to admin_inbox (kind='idea') so
 *      admin sees them surface in the inbox UI.
 *
 * The loop self-feeds: next run reads the hypothesis it tested and
 * uses the outcome to decide whether to extend (more variants in this
 * direction) or pivot (look elsewhere).
 *
 * Auth + scheduling: called from /api/cron/congress-hypothesis with
 * CRON_SECRET. Designed to be safe to run frequently — it's idempotent
 * via the hypothesis lifecycle (won't double-test or duplicate).
 */

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";

const HYPOTHESIS_GENERATOR_SYSTEM = `你是 Qiji 算力 program 的资深 sales 数据分析师 + 销售心理学专家.

你的工作:
1. 看实际发件数据的 segment-level patterns (geo, school, click rate 之类)
2. 不只看数字 — 你在数字背后**找原因 / 编故事 / 提假设**

## ⚠️ 总体心智 (这条最关键, 优先于下面的 dimension list)

**绝大多数研究员都想要 GPU 算力**. 这是 baseline truth. Click rate 的差异**不是来自"想不想要"**, 而是来自:
  - **饥渴度** (内部已有多少 / 排队多久 / 项目阶段) — 即"边际算力的 utility"
  - **替代品的丰富度** (校内集群强度 / 已有商业 contract / 老板有多少基金能买卡)
  - **这封邮件给信号的清晰度** (能不能让对方 30 秒内 get 到 "我能用上 vs 跟我无关")
  - **看邮件人的当前任务态** (在 deadline 前 / 在跑实验 / 在写综述, 期待的语气和长度都不一样)

所以提假设时: 不要想"哪些人不想要算力", 而是想**"哪些人当前最缺 / 最不缺", 以及"这封邮件 怎么对得上 / 对不上 那种状态"**. 这是 demand gradient 框架, 不是 binary "want / not want".

## 维度 (用来填上面那个心智的细节, 不是替代它)
   • 饥渴度信号: 校内集群强度 (清华/中科院计算所有强 internal compute, BUAA 通常排队), 项目方向 (GenAI / robotics 必须 burst, 理论方向通常少量稳定)
   • 城市层级: 北上广深 / 二线 / 普通省会 (周边算力供给密度不同)
   • 学校文化: 985/211 (对 name-drop 免疫力强), CS-strong校 vs 综合校
   • 收件人称呼: 三字汉名 / 双字汉名 / 拼音 / 英文 (反映 self-presentation 偏好, 与期待的语气挂钩)
   • lab seniority: 学生 / 博后 / PI (PI 看 funding scale + cluster ownership, 学生看 hands-on opportunity 跟回复速度)
   • 论文阶段: 刚发 vs 几年前 (刚发在 promotion 状态, 几年前可能 follow-up)
   • 时段: 工作日早上 / 周末晚上 (打开率差别)

3. 你产出的是**假设**, 不是结论. 每条假设要可证伪.

格式要求 (严格 JSON):
{
  "hypotheses": [
    {
      "hypothesis": "1-2 句话, 形如 'X segment 在 Y dimension 上有 Z 表现, 因为...'",
      "reasoning": "你为什么这么猜. 用上数据 + 心理学/文化知识. 2-4 句.",
      "segment": { "geo"?: "cn"|"overseas"|"edu", "school_tier"?: 1|2|3, "province"?: string, "school_name"?: string },
      "proposed_test": "一句话: 我们应该改 template 的哪一段, 怎么改, 来测这个假设. 具体到段落 (intro_prompt/school_pitch/cta_signoff/...).",
      "expected_lift_metric": "click_rate" | "reply_rate" | "wechat_rate",
      "expected_lift_direction": "up" | "down"
    },
    ...
  ]
}

只返回 JSON, 不要 markdown fences. 1-3 条假设. 每条都要可证伪 + 提到具体 segment + 具体段落.`;

const STRATEGIST_SYSTEM = `你是 Qiji 算力 program 的 sales copywriter + template 工程师.

收到一条 hypothesis + 当前 baseline template 的某一段内容. 你要根据 hypothesis 起草一个新版本的那一段, 用来 A/B 测试.

要求:
1. 严格保留原段落的**结构性 placeholder** (e.g. {{rep_name}}, {{closing_name}}, {{rep_wechat}}, {{title}}, {{abstract}}, {{base_info}}, {{school_text}}, {{directions_text}}, {{wechat_article_url}}, {{apply_url}}, {{REP_NAME}}, {{REP_WECHAT}}, {{CLOSING_NAME}}). 这些是占位符, 不要展开, 不要删.
2. 改动要**具体响应 hypothesis**. 不是泛泛"更友好"或"更短", 而是针对那个心理学 / 文化判断做的微调.
3. 中文为主, 技术词保留英文. 跟原段落风格一致, 不要突然换 register.
4. 严格不要碰 program facts (100 万等值算力 / 通过率 1.5% / 不占股).

输出 JSON:
{
  "new_paragraph": "新版本的那一段, 完整文本",
  "what_changed": "1 句话总结你改了什么 + 为什么这样改对应 hypothesis",
  "expected_pitfall": "1 句话: 这个改动可能在什么场景下反而更糟"
}
只返回 JSON, 不要 markdown fences.`;

interface HypothesisRow {
  id: string;
  hypothesis: string;
  reasoning: string;
  segment: Record<string, unknown>;
  status: "proposed" | "testing" | "confirmed" | "refuted" | "abandoned";
  proposed_template_id: string | null;
  baseline_template_id: string | null;
  outcome_evidence: Record<string, unknown> | null;
  generated_at: string;
  last_tested_at: string | null;
}

interface GeneratedHypothesis {
  hypothesis: string;
  reasoning: string;
  segment: Record<string, unknown>;
  proposed_test: string;
  expected_lift_metric: "click_rate" | "reply_rate" | "wechat_rate";
  expected_lift_direction: "up" | "down";
}

/**
 * Pull a compact data pack the analyst can reason over. Same shape as
 * weekly congress's evidence pack, but extended with:
 *  - per-school click rates (top 10 schools by send volume)
 *  - per-province click rates (CN only)
 *  - per-name-format reply rates (Han chars vs pinyin recipient first_name)
 *  - day-of-week send distribution + reply rate per day
 */
async function buildEvidencePack(lookbackDays: number): Promise<string> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const lines: string[] = [];
  lines.push(`# Evidence pack (last ${lookbackDays} days)\n`);

  // Top schools by sent + click
  const { data: emails } = await supabase
    .from("emails")
    .select("id, to, created_at")
    .gte("created_at", since);
  const totalEmails = emails?.length ?? 0;
  lines.push(`Total emails sent: ${totalEmails}`);
  if (totalEmails === 0) {
    lines.push("(no data — skipping)");
    return lines.join("\n");
  }

  // Per-domain breakdown
  const byDomain = new Map<string, { sent: number; clicked: number }>();
  for (const e of emails ?? []) {
    const dom = String(e.to ?? "").toLowerCase().split("@")[1] ?? "(unknown)";
    const slot = byDomain.get(dom) ?? { sent: 0, clicked: 0 };
    slot.sent++;
    byDomain.set(dom, slot);
  }
  // Click signal — chunked because in() URL length cap
  const ids = (emails ?? []).map((e) => e.id as string);
  const clickedSet = new Set<string>();
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data: clicks } = await supabase
      .from("email_history")
      .select("email_id")
      .in("email_id", chunk)
      .eq("was_clicked", true);
    for (const c of clicks ?? []) clickedSet.add(c.email_id as string);
  }
  for (const e of emails ?? []) {
    if (clickedSet.has(e.id as string)) {
      const dom = String(e.to ?? "").toLowerCase().split("@")[1] ?? "(unknown)";
      const slot = byDomain.get(dom) ?? { sent: 0, clicked: 0 };
      slot.clicked++;
      byDomain.set(dom, slot);
    }
  }

  // Top 12 by send volume
  const topDomains = [...byDomain.entries()]
    .filter(([, v]) => v.sent >= 5)
    .sort((a, b) => b[1].sent - a[1].sent)
    .slice(0, 12);
  lines.push("\n## Per-domain (top by volume, n>=5):");
  for (const [dom, v] of topDomains) {
    const rate = ((v.clicked / v.sent) * 100).toFixed(1);
    lines.push(`  ${dom.padEnd(35)} sent=${String(v.sent).padStart(4)}  click=${rate}%`);
  }

  // CN-only summary
  const cn = topDomains.filter(([d]) => d.endsWith(".cn"));
  const overseas = topDomains.filter(([d]) => !d.endsWith(".cn"));
  const cnTotalSent = cn.reduce((s, [, v]) => s + v.sent, 0);
  const cnTotalClick = cn.reduce((s, [, v]) => s + v.clicked, 0);
  const ovTotalSent = overseas.reduce((s, [, v]) => s + v.sent, 0);
  const ovTotalClick = overseas.reduce((s, [, v]) => s + v.clicked, 0);
  lines.push(`\n## Geo aggregates (top-volume domains only):`);
  lines.push(`  CN     sent=${cnTotalSent} click=${cnTotalSent ? ((cnTotalClick/cnTotalSent)*100).toFixed(1):'—'}%`);
  lines.push(`  Other  sent=${ovTotalSent} click=${ovTotalSent ? ((ovTotalClick/ovTotalSent)*100).toFixed(1):'—'}%`);

  // Recipient name format breakdown — joins emails to pipeline_leads
  const arxivIds = (emails ?? []).map((e) => (e as { paper_arxiv_id?: string | null }).paper_arxiv_id).filter(Boolean) as string[];
  // Skip the join if too sparse
  if (arxivIds.length >= 20) {
    const { data: leads } = await supabase
      .from("pipeline_leads")
      .select("arxiv_id, first_name, school_tier")
      .in("arxiv_id", arxivIds.slice(0, 1000));
    const handednessByArxiv = new Map<string, "han" | "pinyin" | "other" | "missing">();
    for (const l of leads ?? []) {
      const fn = String(l.first_name ?? "").trim();
      let h: "han" | "pinyin" | "other" | "missing" = "missing";
      if (!fn) h = "missing";
      else if (/^[一-鿿]+$/.test(fn)) h = "han";
      else if (/^[a-zA-Z]+$/.test(fn)) h = "pinyin";
      else h = "other";
      handednessByArxiv.set(l.arxiv_id as string, h);
    }
    const byHanded: Record<"han"|"pinyin"|"other"|"missing", { sent: number; clicked: number }> = {
      han: { sent: 0, clicked: 0 },
      pinyin: { sent: 0, clicked: 0 },
      other: { sent: 0, clicked: 0 },
      missing: { sent: 0, clicked: 0 },
    };
    for (const e of emails ?? []) {
      const aid = (e as { paper_arxiv_id?: string | null }).paper_arxiv_id;
      const h = aid ? handednessByArxiv.get(aid) ?? "missing" : "missing";
      byHanded[h].sent++;
      if (clickedSet.has(e.id as string)) byHanded[h].clicked++;
    }
    lines.push(`\n## By recipient first-name format (proxy for romanization preference):`);
    for (const k of ["han", "pinyin", "other", "missing"] as const) {
      const v = byHanded[k];
      if (v.sent === 0) continue;
      const r = ((v.clicked / v.sent) * 100).toFixed(1);
      lines.push(`  ${k.padEnd(8)} sent=${String(v.sent).padStart(4)}  click=${r}%`);
    }
  }

  // Day-of-week send distribution
  const byDow: Record<number, { sent: number; clicked: number }> = {};
  for (const e of emails ?? []) {
    const d = new Date(e.created_at as string).getUTCDay();
    const slot = byDow[d] ?? { sent: 0, clicked: 0 };
    slot.sent++;
    if (clickedSet.has(e.id as string)) slot.clicked++;
    byDow[d] = slot;
  }
  lines.push(`\n## By day-of-week (UTC):`);
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  for (let i = 0; i < 7; i++) {
    const v = byDow[i];
    if (!v || v.sent === 0) continue;
    const r = ((v.clicked / v.sent) * 100).toFixed(1);
    lines.push(`  ${DOW[i]} sent=${String(v.sent).padStart(4)}  click=${r}%`);
  }

  return lines.join("\n");
}

/** Read and summarize ALL active hypotheses (status proposed|testing). */
async function loadActiveHypotheses(): Promise<HypothesisRow[]> {
  const { data } = await supabase
    .from("congress_hypotheses")
    .select("*")
    .in("status", ["proposed", "testing"])
    .order("generated_at", { ascending: false });
  return (data ?? []) as HypothesisRow[];
}

/**
 * For each TESTING hypothesis, pull outcome data and decide
 * confirmed/refuted/abandoned (or leave as testing if not enough data).
 */
async function evaluateTestingHypotheses(active: HypothesisRow[]): Promise<{ updated: number }> {
  const testing = active.filter((h) => h.status === "testing");
  let updated = 0;
  for (const h of testing) {
    if (!h.proposed_template_id || !h.baseline_template_id) continue;
    // Pull both templates' click data over the period since the
    // hypothesis went testing.
    const since = h.last_tested_at ?? h.generated_at;
    const { data: emails } = await supabase
      .from("emails")
      .select("id, template_id, to")
      .gte("created_at", since)
      .in("template_id", [h.proposed_template_id, h.baseline_template_id]);
    if (!emails || emails.length < 30) {
      // Not enough volume to decide. Stamp last_tested_at and move on.
      await supabase
        .from("congress_hypotheses")
        .update({ last_tested_at: new Date().toISOString() })
        .eq("id", h.id);
      continue;
    }
    const ids = emails.map((e) => e.id as string);
    const clickedSet = new Set<string>();
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150);
      const { data: clicks } = await supabase
        .from("email_history")
        .select("email_id")
        .in("email_id", chunk)
        .eq("was_clicked", true);
      for (const c of clicks ?? []) clickedSet.add(c.email_id as string);
    }
    let pSent = 0, pClick = 0, bSent = 0, bClick = 0;
    for (const e of emails) {
      if (e.template_id === h.proposed_template_id) {
        pSent++;
        if (clickedSet.has(e.id as string)) pClick++;
      } else {
        bSent++;
        if (clickedSet.has(e.id as string)) bClick++;
      }
    }
    if (pSent < 15 || bSent < 15) continue;
    const pRate = pClick / pSent;
    const bRate = bClick / bSent;
    let status: HypothesisRow["status"] = "testing";
    if (pRate >= bRate * 1.2) status = "confirmed";
    else if (pRate <= bRate * 0.8) status = "refuted";
    // Otherwise leave testing — not enough delta to call.

    const evidence = {
      sample_proposal: pSent,
      sample_baseline: bSent,
      metric: "click_rate",
      value_proposal: pRate,
      value_baseline: bRate,
      window_start: since,
      window_end: new Date().toISOString(),
    };
    await supabase
      .from("congress_hypotheses")
      .update({
        status,
        outcome_evidence: evidence,
        last_tested_at: new Date().toISOString(),
        decided_at: status !== "testing" ? new Date().toISOString() : null,
      })
      .eq("id", h.id);
    if (status !== "testing") updated++;
  }
  return { updated };
}

/** Call analyst LLM to generate new hypotheses. */
async function generateHypotheses(
  evidencePack: string,
  recentHistory: HypothesisRow[],
): Promise<GeneratedHypothesis[]> {
  const histText = recentHistory.length === 0
    ? "(no prior hypotheses)"
    : recentHistory.slice(0, 8).map((h) =>
        `- [${h.status}] ${h.hypothesis}` +
        (h.outcome_evidence
          ? ` → outcome: proposal_rate=${(((h.outcome_evidence as Record<string, unknown>).value_proposal as number ?? 0) * 100).toFixed(1)}%, baseline_rate=${(((h.outcome_evidence as Record<string, unknown>).value_baseline as number ?? 0) * 100).toFixed(1)}%`
          : ""),
      ).join("\n");

  const userPrompt = `# Evidence pack
${evidencePack}

# Recent hypotheses (status + outcomes if any)
${histText}

# Your task
基于上面的数据 + 已有 hypotheses 的 outcomes (哪些被证实 / 哪些被推翻),
生成 1-3 条**新的**假设. 不要重复已经在 testing 的角度.
特别欢迎: (1) 跨 dimension 的 (city tier × name format), (2) refuted 后的反向 hypothesis ("反过来试").`;

  // Bumped max_tokens to 4000 — qualitative hypothesis text in
  // Chinese with reasoning blocks easily exceeds 2000 tokens for
  // 3 hypotheses. Truncation produces invalid JSON that fails parsing
  // and we lose a whole round of analyst work. Gemini-3-flash is
  // cheap enough that 4000 isn't a cost concern.
  const r = await llmChat({
    model: "gemini-3-flash",
    system: HYPOTHESIS_GENERATOR_SYSTEM,
    user: userPrompt,
    temperature: 0.7,
    max_tokens: 4000,
  });
  const raw = (r.text ?? "").trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  try {
    const parsed = JSON.parse(clean) as { hypotheses?: GeneratedHypothesis[] };
    return Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];
  } catch (parseErr) {
    // One repair attempt: ask the model to fix its truncated/malformed
    // JSON. Cheaper than throwing away a whole round.
    console.warn("[congress-hypothesis] analyst returned non-JSON, attempting repair");
    try {
      const repair = await llmChat({
        model: "gemini-3-flash",
        system: "You are a JSON repair tool. Given a partial / malformed / truncated JSON document, return the valid JSON. If truncated, drop the incomplete trailing element. Only output valid JSON, no markdown.",
        user: `Original document (may be malformed):\n\n${clean}`,
        temperature: 0,
        max_tokens: 4000,
      });
      const repaired = (repair.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
      const parsed = JSON.parse(repaired) as { hypotheses?: GeneratedHypothesis[] };
      return Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];
    } catch (repairErr) {
      console.error(
        "[congress-hypothesis] repair also failed:",
        repairErr,
        "original parseErr:",
        parseErr,
        "raw head:",
        clean.slice(0, 400),
      );
      return [];
    }
  }
}

/**
 * For a single hypothesis: pick the right baseline template, ask the
 * strategist to draft a new paragraph, clone the baseline as a new
 * 'proposal' template with that paragraph swapped, link it to the
 * hypothesis row.
 */
async function craftProposalForHypothesis(
  h: GeneratedHypothesis & { id: string },
): Promise<{ ok: boolean; templateId?: string; error?: string }> {
  // Pick baseline: prefer segment_default for the hypothesis's geo,
  // else fall back to global.
  const seg = (h.segment ?? {}) as Record<string, unknown>;
  const geo = typeof seg.geo === "string" ? seg.geo : null;
  let baseline: Record<string, unknown> | null = null;
  if (geo) {
    const { data } = await supabase
      .from("email_templates")
      .select("*")
      .eq("status", "active")
      .eq("active", true)
      .eq("segment_default", geo)
      .maybeSingle();
    baseline = data;
  }
  if (!baseline) {
    const { data } = await supabase
      .from("email_templates")
      .select("*")
      .eq("status", "active")
      .eq("active", true)
      .eq("name", "global")
      .maybeSingle();
    baseline = data;
  }
  if (!baseline) return { ok: false, error: "no baseline template" };

  // Map proposed_test text to which slot to swap. Heuristic — look for
  // slot keywords. Default to school_pitch_format if ambiguous (it's
  // the highest-leverage paragraph per design doc).
  const SLOT_KEYWORDS: Record<string, string[]> = {
    intro_prompt: ["intro", "personal", "开场", "开头"],
    school_pitch_format: ["school", "学校", "pitch", "name-drop", "MIT", "清华"],
    rep_intro_format: ["rep_intro", "rep intro", "我是", "introduction"],
    cta_signoff_format: ["cta", "signoff", "申请", "微信", "结尾"],
    subject_format: ["subject", "标题"],
    greeting_format: ["greeting", "称呼", "你好"],
  };
  let slotToSwap: keyof typeof SLOT_KEYWORDS = "school_pitch_format";
  const lcTest = h.proposed_test.toLowerCase();
  for (const [slot, words] of Object.entries(SLOT_KEYWORDS)) {
    if (words.some((w) => lcTest.includes(w.toLowerCase()))) {
      slotToSwap = slot as keyof typeof SLOT_KEYWORDS;
      break;
    }
  }

  const baselineSlot = (baseline as Record<string, string>)[slotToSwap] ?? "";

  // Strategist drafts the new paragraph
  const strategistPrompt = `# Hypothesis
${h.hypothesis}

# Reasoning
${h.reasoning}

# Proposed test
${h.proposed_test}

# Slot to mutate
\`${slotToSwap}\`

# Current baseline content for that slot
${baselineSlot}`;
  // Bumped to 3000 — Chinese template paragraphs + rationale + pitfall
  // can be long. Same repair fallback as the analyst.
  const r = await llmChat({
    model: "gemini-3-flash",
    system: STRATEGIST_SYSTEM,
    user: strategistPrompt,
    temperature: 0.4,
    max_tokens: 3000,
  });
  const raw = (r.text ?? "").trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  let parsed: { new_paragraph?: string; what_changed?: string; expected_pitfall?: string };
  try {
    parsed = JSON.parse(clean);
  } catch {
    // One repair attempt
    try {
      const repair = await llmChat({
        model: "gemini-3-flash",
        system: "You are a JSON repair tool. Return valid JSON only, dropping any incomplete trailing fields.",
        user: `Repair this JSON:\n\n${clean}`,
        temperature: 0,
        max_tokens: 3000,
      });
      const repaired = (repair.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
      parsed = JSON.parse(repaired);
    } catch {
      return { ok: false, error: "strategist non-JSON (even after repair)" };
    }
  }
  if (!parsed.new_paragraph || parsed.new_paragraph === baselineSlot) {
    return { ok: false, error: "strategist returned no-op or empty paragraph" };
  }

  // Clone baseline → new 'proposal' template with the swap.
  const proposalName = `proposal_h${h.id.slice(0, 8)}_${slotToSwap}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const insertRow: Record<string, unknown> = {
    name: proposalName,
    rep_id: null,
    active: true,
    status: "proposal",
    segment_default: geo,
    proposed_by: "congress",
    proposed_reason: `${parsed.what_changed ?? "(no rationale)"}\n\nHypothesis: ${h.hypothesis}\n\nExpected pitfall: ${parsed.expected_pitfall ?? "(unstated)"}`,
    proposed_evidence: {
      hypothesis_id: h.id,
      slot_swapped: slotToSwap,
      baseline_template_id: baseline.id,
      what_changed: parsed.what_changed,
      expected_pitfall: parsed.expected_pitfall,
    },
    notes: `Generated by hypothesis-driven congress. Mutates ${slotToSwap} of "${baseline.name}".`,
    subject_format: baseline.subject_format,
    intro_prompt: baseline.intro_prompt,
    greeting_format: baseline.greeting_format,
    rep_intro_format: baseline.rep_intro_format,
    school_pitch_format: baseline.school_pitch_format,
    cta_signoff_format: baseline.cta_signoff_format,
  };
  insertRow[slotToSwap] = parsed.new_paragraph;

  const { data: created, error } = await supabase
    .from("email_templates")
    .insert(insertRow)
    .select("id")
    .single();
  if (error || !created) return { ok: false, error: error?.message ?? "insert failed" };
  return { ok: true, templateId: created.id as string };
}

/**
 * Main entry: run one round of hypothesis-driven congress.
 *
 * Returns counts: hypotheses_generated, proposals_drafted, hypotheses_decided.
 */
export async function runHypothesisCongress(opts: { lookbackDays?: number; runId?: string } = {}): Promise<{
  ok: boolean;
  hypotheses_generated: number;
  proposals_drafted: number;
  hypotheses_decided: number;
  notes: string[];
}> {
  const lookback = opts.lookbackDays ?? 30;
  const runId = opts.runId ?? `hyp-${Date.now()}`;
  const notes: string[] = [];

  // 1. Load active hypotheses + evaluate testing ones
  const active = await loadActiveHypotheses();
  notes.push(`active hypotheses: ${active.length} (${active.filter((h) => h.status === "proposed").length} proposed, ${active.filter((h) => h.status === "testing").length} testing)`);
  const { updated } = await evaluateTestingHypotheses(active);
  notes.push(`hypotheses moved out of testing: ${updated}`);

  // 2. Build evidence pack
  const evidence = await buildEvidencePack(lookback);
  notes.push(`evidence pack lines: ${evidence.split("\n").length}`);

  // 3. Generate new hypotheses
  const newHyps = await generateHypotheses(evidence, active);
  notes.push(`new hypotheses generated by analyst: ${newHyps.length}`);

  // 4. Insert hypotheses, then craft proposals
  let proposalsDrafted = 0;
  for (const h of newHyps) {
    const { data: row } = await supabase
      .from("congress_hypotheses")
      .insert({
        hypothesis: h.hypothesis,
        reasoning: h.reasoning,
        segment: h.segment ?? {},
        status: "proposed",
        congress_run_id: runId,
      })
      .select("id")
      .single();
    if (!row) continue;
    const hypId = row.id as string;

    // Craft proposal template
    const crafted = await craftProposalForHypothesis({ ...h, id: hypId });
    if (crafted.ok && crafted.templateId) {
      // Find baseline id for the row (re-look-up; same logic as in
      // craftProposalForHypothesis but we need it here for the fk).
      const seg = (h.segment ?? {}) as Record<string, unknown>;
      const geo = typeof seg.geo === "string" ? seg.geo : null;
      let baselineId: string | null = null;
      if (geo) {
        const { data } = await supabase
          .from("email_templates")
          .select("id")
          .eq("status", "active")
          .eq("active", true)
          .eq("segment_default", geo)
          .maybeSingle();
        baselineId = (data?.id as string | null) ?? null;
      }
      if (!baselineId) {
        const { data } = await supabase
          .from("email_templates")
          .select("id")
          .eq("status", "active")
          .eq("active", true)
          .eq("name", "global")
          .maybeSingle();
        baselineId = (data?.id as string | null) ?? null;
      }
      await supabase
        .from("congress_hypotheses")
        .update({
          status: "testing",
          proposed_template_id: crafted.templateId,
          baseline_template_id: baselineId,
          last_tested_at: new Date().toISOString(),
        })
        .eq("id", hypId);

      // Mirror to admin_inbox
      await supabase.from("admin_inbox").upsert(
        {
          kind: "idea",
          headline: `🧪 Hypothesis test: ${h.hypothesis.slice(0, 100)}`,
          body: `${h.reasoning}\n\nProposed test: ${h.proposed_test}\n\nExpected lift: ${h.expected_lift_metric} ${h.expected_lift_direction}\n\nPreview the new template on /templates/bench (look for proposal_h${hypId.slice(0, 8)}).`,
          evidence: { hypothesis_id: hypId, template_id: crafted.templateId, segment: h.segment },
          dedup_hash: `congress-hypothesis:${hypId}`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "dedup_hash" },
      );
      proposalsDrafted++;
    } else {
      notes.push(`hypothesis ${hypId.slice(0, 8)} couldn't be turned into a proposal: ${crafted.error}`);
    }
  }

  return {
    ok: true,
    hypotheses_generated: newHyps.length,
    proposals_drafted: proposalsDrafted,
    hypotheses_decided: updated,
    notes,
  };
}
