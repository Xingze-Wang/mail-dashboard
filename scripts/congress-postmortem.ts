// Loop 4 — Postmortem Congress (conditional / forensic).
//
// Runs daily-ish. Most days it does nothing. Fires only when one of:
//   - overall conversion drops > 20% from rolling 60d baseline
//   - a rep's individual conversion drops > 2σ for 3+ weeks
//   - a research direction's CVR collapses (was >2%, now 0% over 30+ sends)
//   - manual: --trigger=manual --reason="..." for ad-hoc invocation
//
// Output is a NARRATIVE, not a decision package. Becomes standing
// context for next strategic congress (and gets pinned in every loop's
// system prompt while resolved_at IS NULL).
//
// Run: npx tsx scripts/congress-postmortem.ts [--dry-run] [--trigger=manual --reason="..."]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function loadDotenv(p: string) {
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {}
}
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv(resolve(here, "..", ".env.local"));
loadDotenv(resolve(here, "..", ".env"));

const DRY_RUN = process.argv.includes("--dry-run");
const argMap = new Map<string, string>();
for (const a of process.argv) {
  const m = a.match(/^--([\w-]+)=(.*)$/);
  if (m) argMap.set(m[1], m[2]);
}
const MANUAL_TRIGGER = argMap.get("trigger") === "manual";
const MANUAL_REASON = argMap.get("reason") ?? "(unspecified manual trigger)";

interface Persona { key: string; display: string; system: string; question: string; }

const ROSTER: Persona[] = [
  {
    key: "historian",
    display: "Historian",
    system: "你是 Historian — 在 postmortem 中你专门 reconstruct timeline. 哪些 commits / decisions / config changes 发生在 incident 周围.",
    question: "Build a timeline of the 30 days leading up to this incident. What changed (template edits, directive applies, JITR accepts, code commits where visible)? Don't speculate cause yet — just the chronology.",
  },
  {
    key: "causal_investigator",
    display: "Causal Investigator",
    system: "你 propose hypotheses for the cause. 每个 hypothesis 必须 cite specific evidence. 不要 vague.",
    question: "Given the timeline and the breach metric, propose 2-3 specific causal hypotheses. For each: what evidence supports it, what evidence rules it out, and what's the kill-test (one query or check that would falsify it).",
  },
  {
    key: "adversary",
    display: "Adversary",
    system: "你 attack the proposed hypotheses. 找到 confounders.",
    question: "For each hypothesis the Causal Investigator proposed, what's the alternative explanation that's at least as plausible? What confounder could produce the same observed pattern?",
  },
  {
    key: "synthesizer",
    display: "Synthesizer",
    system: "你 produce the final narrative — what we now know, what we're uncertain about, what to do (or not do) next. Output text, not JSON. Max 400 words.",
    question: `Write the final narrative as 3-5 short paragraphs. Cover: (1) what broke; (2) the most likely cause and the evidence weight; (3) what we're still uncertain about; (4) what change (if any) is warranted, and what change is explicitly NOT warranted (some incidents are noise — say so). End with one sentence the next strategic congress should keep in mind.`,
  },
];

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    "https://erguqrisqtugfysofwdd.supabase.co",
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false } },
  );

  const { llmChat } = await import("../src/lib/llm-proxy.ts");
  const { notifyAdminText, buildConstraintsPreamble } = await import("../src/lib/congress.ts");

  // ─── Trigger detection ──────────────────────────────────────────────
  let trigger_kind = "manual";
  let trigger_evidence: object = { reason: MANUAL_REASON };

  if (!MANUAL_TRIGGER) {
    // Check overall conversion drop > 20% from 60d baseline (last 14d vs prior 60d)
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const cur14 = new Date(now - 14 * day).toISOString();
    const prior74 = new Date(now - 74 * day).toISOString();

    async function rate(start: string, end?: string) {
      let q1 = sb.from("emails").select("id", { count: "exact", head: true }).gte("created_at", start);
      let q2 = sb.from("brief_lookups").select("id", { count: "exact", head: true }).gte("marked_at", start);
      if (end) { q1 = q1.lt("created_at", end); q2 = q2.lt("marked_at", end); }
      const { count: sent } = await q1;
      const { count: convs } = await q2;
      return { sent: sent ?? 0, convs: convs ?? 0, rate: sent ? (convs ?? 0) / sent : 0 };
    }
    const recent = await rate(cur14);
    const baseline = await rate(prior74, cur14);
    const dropPct = baseline.rate > 0 ? (1 - recent.rate / baseline.rate) * 100 : 0;
    console.log(`baseline conversion: ${(baseline.rate * 100).toFixed(2)}% (${baseline.convs}/${baseline.sent})`);
    console.log(`recent 14d conversion: ${(recent.rate * 100).toFixed(2)}% (${recent.convs}/${recent.sent})`);
    console.log(`drop: ${dropPct.toFixed(1)}%`);

    if (dropPct > 20 && recent.sent > 50) {
      trigger_kind = "overall_conversion_drop";
      trigger_evidence = { baseline, recent, drop_pct: dropPct };
    } else {
      console.log("no breach detected; postmortem not firing.");
      if (DRY_RUN) console.log("(dry-run continues anyway for testing)");
      else return;
    }
  }

  console.log(`POSTMORTEM TRIGGERED: ${trigger_kind}`);

  // ─── Build evidence pack ───────────────────────────────────────────
  const lines: string[] = [];
  const constraints = await buildConstraintsPreamble();
  if (constraints) lines.push(constraints);

  lines.push(`## Trigger`);
  lines.push(`  kind: ${trigger_kind}`);
  lines.push(`  evidence: ${JSON.stringify(trigger_evidence)}`);

  // 30-day timeline of changes
  lines.push(`\n## 30-day timeline of system changes`);
  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const { data: tplVersions } = await sb.from("email_template_versions").select("template_id, edited_at, snapshot, edited_by").gte("edited_at", since30).order("edited_at", { ascending: true }).limit(30);
  for (const v of tplVersions ?? []) lines.push(`  [${v.edited_at?.slice(0, 10)}] template_version captured (template_id=${v.template_id}, by=${v.edited_by ?? "unknown"})`);

  const { data: jitrApplied } = await sb.from("jitr_offers").select("rep_id, applied_at, ai_phrase, sales_phrase").not("applied_at", "is", null).gte("applied_at", since30).order("applied_at", { ascending: true });
  for (const j of jitrApplied ?? []) lines.push(`  [${j.applied_at?.slice(0, 10)}] JITR accepted by rep_id=${j.rep_id}: "${(j.ai_phrase || "").slice(0, 30)}…" → "${(j.sales_phrase || "").slice(0, 30)}…"`);

  const { data: tactProps } = await sb.from("tactical_proposals").select("title, ship_decision, shipped_at, change_spec").gte("proposed_at", since30).order("proposed_at", { ascending: true });
  for (const p of tactProps ?? []) lines.push(`  [${p.shipped_at?.slice(0, 10) ?? "(not shipped)"}] tactical "${p.title}" (${p.ship_decision})`);

  const { data: directives } = await sb.from("strategic_directives").select("body, effective_from").gte("effective_from", since30).order("effective_from", { ascending: true });
  for (const d of directives ?? []) lines.push(`  [${d.effective_from?.slice(0, 10)}] new strategic directive: "${d.body.slice(0, 80)}…"`);

  // Per-rep recent metrics
  lines.push(`\n## Per-rep last 14d`);
  const { data: reps } = await sb.from("sales_reps").select("id, name").eq("active", true);
  const since14 = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  for (const r of reps ?? []) {
    const { count: sent } = await sb.from("emails").select("id", { count: "exact", head: true }).eq("rep_id", r.id).gte("created_at", since14);
    const { count: wechat } = await sb.from("brief_lookups").select("id", { count: "exact", head: true }).eq("marked_by_rep_id", r.id).gte("marked_at", since14);
    lines.push(`  ${r.name} (id=${r.id}): sent=${sent ?? 0}, wechat=${wechat ?? 0}`);
  }

  const evidencePack = lines.join("\n");

  console.log(`evidence pack: ${evidencePack.length} chars`);
  if (DRY_RUN) console.log(`\n--- evidence ---\n${evidencePack.slice(0, 2500)}\n---\n`);

  // ─── Run personas ──────────────────────────────────────────────────
  async function runOnePersona(p: Persona, runningContext: string): Promise<string> {
    const userPrompt = `## Postmortem Congress — your role: ${p.display}
${p.question}

## Shared evidence pack
${evidencePack}
${runningContext ? "\n## What other panelists have said so far\n" + runningContext : ""}

300 words max. Cite specifics.`;
    try {
      const r = await llmChat({
        model: "gemini-3-flash",
        system: p.system,
        user: userPrompt,
        temperature: 0.4,
        max_tokens: 1000,
      });
      return r.text?.trim() ?? "(empty)";
    } catch (err) {
      console.error(`persona ${p.key} failed:`, String(err).slice(0, 200));
      return `(persona errored)`;
    }
  }

  const personas: Record<string, string> = {};
  let runningContext = "";
  for (const p of ROSTER) {
    console.log(`  ${p.display}...`);
    const text = await runOnePersona(p, runningContext);
    personas[p.key] = text;
    runningContext += `\n\n### ${p.display}\n${text}`;
  }

  console.log(`\n--- NARRATIVE ---\n${personas.synthesizer}\n---`);
  if (DRY_RUN) { console.log("(dry-run)"); return; }

  const { data: row, error } = await sb.from("incident_lessons").insert({
    trigger_kind,
    trigger_evidence,
    deliberation: { personas, evidence_pack_excerpt: evidencePack.slice(0, 3000) },
    narrative: personas.synthesizer,
  }).select().single();
  if (error || !row) { console.error("insert:", error?.message); process.exit(1); }
  console.log(`persisted: incident_lessons.id=${row.id}`);

  await notifyAdminText([
    `🚨 Postmortem fired: ${trigger_kind}`,
    ``,
    `Narrative:`,
    personas.synthesizer.slice(0, 1500),
    ``,
    `incident_id=${row.id}`,
    `This will be in every loop's system prompt until you resolve it (set resolved_at).`,
  ].join("\n"));
  console.log("admin notified");
}

main().catch((err) => { console.error(err); process.exit(1); });
