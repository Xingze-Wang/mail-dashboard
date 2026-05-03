// Loop 3 — Monthly Strategic Congress.
//
// First Monday of the month. Different roster (Historian, Funnel
// Economist, Constituent Advocate, Adversary, Synthesizer). Different
// question: structural changes — adding/removing arXiv categories,
// redefining tier thresholds, killing distinctions, expanding to new
// communities.
//
// Critically: the Historian grades Loop 2's homework. A tactical
// proposal whose evaluation_due_at has passed is fed to the Historian
// with actual_lift computed from emails since shipped_at.
//
// Run: npx tsx scripts/congress-monthly.ts [--dry-run]

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

interface Persona { key: string; display: string; system: string; question: string; }

const ROSTER: Persona[] = [
  {
    key: "historian",
    display: "Historian",
    system: "你是 Historian — 专门 grade 过去 90 天 tactical congress 通过的决定. 比较 expected_lift 和 actual_lift. 不留情面.",
    question: "Read the graded tactical proposals in the evidence pack. Did last quarter's congress actually move conversion, or did we ship N changes that net-zeroed? For each graded proposal, give a one-line verdict (hit / partial / miss / inconclusive) with the numbers.",
  },
  {
    key: "funnel_economist",
    display: "Funnel Economist",
    system: "你是 funnel economist — 看整个漏斗 as a unit. arxiv-scan-rate → email-sent → opened → clicked → wechat-add → grant-issued. 找 actual bottleneck.",
    question: "Look at the funnel rates in the evidence pack. Which stage is the actual bottleneck? Are we optimizing the wrong stage? If you had to pick ONE stage to attack next quarter, which and why?",
  },
  {
    key: "constituent_advocate",
    display: "Constituent Advocate",
    system: "你 speaks for both researcher AND rep as humans, 不是 conversion targets. 关心 long-term trust + experience.",
    question: "Beyond metrics, what's degrading or improving in the human experience — for the recipient researchers AND for our reps? Cite specific evidence (helper bot conversations, inbound replies, rep tone).",
  },
  {
    key: "adversary",
    display: "Adversary",
    system: "你 attack proposed STRATEGIC changes — not tactical ones. Bigger swings, more skepticism.",
    question: "If the panel proposes a structural change (new category, threshold redefinition, kill a distinction, hire a 6th rep), what's the most likely failure mode? What evidence is the proposal missing?",
  },
  {
    key: "synthesizer",
    display: "Synthesizer",
    system: "你 synthesize the panel into a strategic decision. JSON output only.",
    question: `Produce a JSON object:
{
  "title": "one-line summary of the proposed structural change OR 'no change this month'",
  "outcome": "approved" | "rejected" | "deferred" | "no_proposal",
  "directive_body": "if approved — the one-paragraph directive that goes into strategic_directives.body and constrains Loop 2 going forward",
  "rationale": "why",
  "historian_summary": "one-sentence grade of last quarter overall: net positive / net zero / net negative"
}

If outcome is 'no_proposal' or 'rejected' or 'deferred', leave directive_body empty. JSON only, no markdown fence.`,
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

  // ─── Grade unfinished tactical proposals first (Historian's data) ──
  console.log("Grading tactical proposals due for evaluation...");
  const { data: dueProposals } = await sb
    .from("tactical_proposals")
    .select("*")
    .eq("ship_decision", "approved")
    .is("graded_at", null)
    .lt("evaluation_due_at", new Date().toISOString());

  const graded: Array<{ id: string; title: string; expected: object; actual: object; grade: string }> = [];
  for (const p of dueProposals ?? []) {
    if (!p.shipped_at) continue;
    // Compute actual lift: emails sent in evaluation window vs same window prior year
    const startISO = p.shipped_at;
    const endISO = new Date(new Date(startISO).getTime() + (p.weeks_to_evaluate ?? 4) * 7 * 24 * 3600 * 1000).toISOString();
    const { data: postEmails } = await sb.from("emails").select("status").gte("created_at", startISO).lt("created_at", endISO);
    const postSent = postEmails?.length ?? 0;
    const postOpened = (postEmails ?? []).filter((e: { status: string }) => e.status === "opened" || e.status === "clicked").length;
    const postClicked = (postEmails ?? []).filter((e: { status: string }) => e.status === "clicked").length;
    const actualOpenRate = postSent > 0 ? postOpened / postSent : 0;
    const actualClickRate = postSent > 0 ? postClicked / postSent : 0;

    // Compare against expected
    const exp = p.expected_lift as { metric?: string; delta_pp?: number } | null;
    let grade: "hit" | "partial" | "miss" | "inconclusive" = "inconclusive";
    if (postSent < 30) grade = "inconclusive";
    else if (exp?.metric === "open_rate" && exp?.delta_pp != null) {
      // Need a baseline — use prior 4 weeks before shipped_at
      const baseStart = new Date(new Date(startISO).getTime() - 28 * 24 * 3600 * 1000).toISOString();
      const { data: baseEmails } = await sb.from("emails").select("status").gte("created_at", baseStart).lt("created_at", startISO);
      const baseSent = baseEmails?.length ?? 0;
      const baseOpened = (baseEmails ?? []).filter((e: { status: string }) => e.status === "opened" || e.status === "clicked").length;
      const baseRate = baseSent > 0 ? baseOpened / baseSent : 0;
      const actualDelta = (actualOpenRate - baseRate) * 100;
      if (actualDelta >= exp.delta_pp * 0.8) grade = "hit";
      else if (actualDelta >= exp.delta_pp * 0.3) grade = "partial";
      else grade = "miss";
    }

    const actual = { sent: postSent, open_rate: actualOpenRate, click_rate: actualClickRate };
    graded.push({ id: p.id, title: p.title, expected: exp ?? {}, actual, grade });

    if (!DRY_RUN) {
      await sb.from("tactical_proposals").update({
        graded_at: new Date().toISOString(),
        actual_lift: actual,
        grade,
      }).eq("id", p.id);
    }
  }
  console.log(`graded ${graded.length} tactical proposals`);

  // ─── Build evidence pack ───────────────────────────────────────────
  const lines: string[] = [];
  const constraints = await buildConstraintsPreamble();
  if (constraints) lines.push(constraints);

  lines.push(`## Last quarter's tactical proposals — graded`);
  if (graded.length === 0) {
    lines.push(`(no proposals were due for grading this cycle)`);
  } else {
    for (const g of graded) {
      lines.push(`  [${g.grade}] "${g.title}"`);
      lines.push(`    expected: ${JSON.stringify(g.expected)}`);
      lines.push(`    actual:   ${JSON.stringify(g.actual)}`);
    }
  }

  // 90-day funnel rollup
  lines.push(`\n## 90-day funnel rollup`);
  const start90 = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const { count: leadsScanned } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).gte("created_at", start90);
  const { count: emailsSent } = await sb.from("emails").select("*", { count: "exact", head: true }).gte("created_at", start90);
  const { count: wechatAdds } = await sb.from("brief_lookups").select("*", { count: "exact", head: true }).gte("marked_at", start90);
  const { data: clickEvents, count: clickEventCount } = await sb.from("webhook_events").select("*", { count: "exact", head: false }).eq("type", "email.clicked").gte("created_at", start90).limit(1);
  void clickEvents; // not used directly; just want the count
  lines.push(`  arxiv leads scanned: ${leadsScanned ?? 0}`);
  lines.push(`  emails sent: ${emailsSent ?? 0}`);
  lines.push(`  click events: ${clickEventCount ?? 0}`);
  lines.push(`  wechat adds: ${wechatAdds ?? 0}`);
  if (emailsSent && wechatAdds) lines.push(`  send→wechat conversion: ${(100 * wechatAdds / emailsSent).toFixed(2)}%`);

  // Per-direction CVR
  lines.push(`\n## Per-direction send + conversion (last 90d)`);
  const { data: leadsByDir } = await sb.from("pipeline_leads").select("research_direction, status").gte("created_at", start90);
  const dirTally = new Map<string, { sent: number; total: number }>();
  for (const l of leadsByDir ?? []) {
    const d = (l as { research_direction: string | null }).research_direction || "Other";
    if (!dirTally.has(d)) dirTally.set(d, { sent: 0, total: 0 });
    dirTally.get(d)!.total++;
    if ((l as { status: string }).status === "sent") dirTally.get(d)!.sent++;
  }
  const sortedDirs = [...dirTally].sort((a, b) => b[1].sent - a[1].sent).slice(0, 10);
  for (const [d, t] of sortedDirs) lines.push(`  ${d}: sent=${t.sent}/${t.total}`);

  // Active per-rep templates (signal that JITR is producing outputs)
  const { data: tpls } = await sb.from("email_templates").select("name, rep_id, active").eq("active", true);
  lines.push(`\n## Active email templates`);
  for (const t of tpls ?? []) lines.push(`  ${t.name} (rep_id=${t.rep_id ?? "global"})`);

  const evidencePack = lines.join("\n");

  // ─── Run personas ──────────────────────────────────────────────────
  console.log(`evidence pack: ${evidencePack.length} chars`);
  if (DRY_RUN) console.log(`\n--- evidence ---\n${evidencePack.slice(0, 2000)}\n---\n`);

  async function runOnePersona(p: Persona, runningContext: string): Promise<string> {
    const userPrompt = `## Monthly Strategic Congress — your role: ${p.display}
${p.question}

## Shared evidence pack
${evidencePack}
${runningContext ? "\n## What other panelists have said so far\n" + runningContext : ""}

Speak in your role. 250 words max. Cite specifics. Don't repeat others; push back, refine, add.`;
    try {
      const r = await llmChat({
        model: "gemini-3-flash",
        system: p.system,
        user: userPrompt,
        temperature: 0.5,
        // Synthesizer needs more headroom — its directive_body can be 1-2 paragraphs
        max_tokens: p.key === "synthesizer" ? 2000 : 900,
      });
      return r.text?.trim() ?? "(empty)";
    } catch (err) {
      console.error(`persona ${p.key} failed:`, String(err).slice(0, 200));
      return `(persona errored: ${String(err).slice(0, 100)})`;
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

  let synthJson: { title?: string; outcome?: string; directive_body?: string; rationale?: string; historian_summary?: string };
  try {
    let raw = personas.synthesizer.trim();
    raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    synthJson = JSON.parse(raw);
  } catch (err) {
    console.error("Synthesizer not parseable:", err);
    console.error("Raw:", personas.synthesizer.slice(0, 500));
    process.exit(DRY_RUN ? 0 : 1);
  }

  console.log(`\nOUTCOME: ${synthJson.outcome}`);
  console.log(`Title: ${synthJson.title}`);
  if (synthJson.directive_body) console.log(`Directive: ${synthJson.directive_body.slice(0, 200)}`);

  if (DRY_RUN) { console.log("\n(dry-run)"); return; }

  // Persist strategic_decisions row
  const { data: decRow, error: decErr } = await sb.from("strategic_decisions").insert({
    title: synthJson.title || "(untitled)",
    deliberation: { personas, graded_proposals: graded, evidence_pack_excerpt: evidencePack.slice(0, 3000) },
    outcome: ["approved", "rejected", "deferred"].includes(synthJson.outcome ?? "") ? synthJson.outcome : "deferred",
  }).select().single();
  if (decErr || !decRow) { console.error("decision insert:", decErr?.message); process.exit(1); }

  // If approved, also insert directive
  if (synthJson.outcome === "approved" && synthJson.directive_body) {
    const { data: dirRow } = await sb.from("strategic_directives").insert({
      body: synthJson.directive_body,
      source_decision_id: decRow.id,
      notes: synthJson.rationale,
    }).select().single();
    if (dirRow) {
      await sb.from("strategic_decisions").update({ resulting_directive_id: dirRow.id }).eq("id", decRow.id);
      console.log(`new directive: ${dirRow.id}`);
    }
  }

  const summary = [
    `🏛️ Monthly Strategic Congress`,
    ``,
    `Outcome: ${synthJson.outcome}`,
    `Title: ${synthJson.title}`,
    `Historian's grade on last quarter: ${synthJson.historian_summary || "(no summary)"}`,
    `Graded ${graded.length} tactical proposals: ${graded.map((g) => g.grade).join(", ") || "(none due)"}`,
    ``,
    synthJson.directive_body ? `Active directive (will constrain Loop 2):\n${synthJson.directive_body.slice(0, 400)}` : "(no new directive)",
    ``,
    `Adversary: "${(personas.adversary || "").slice(0, 200)}"`,
    `decision_id=${decRow.id}`,
  ].join("\n");
  await notifyAdminText(summary);
  console.log("admin notified");
}

main().catch((err) => { console.error(err); process.exit(1); });
