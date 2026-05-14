// Loop 2 — Weekly Tactical Congress.
//
// Sunday night → Monday morning. Five personas argue about what to
// ship next; one human approves 1-3 things via Lark cards.
//
// Run: npx tsx scripts/congress-weekly.ts [--dry-run]
//
// Output: 0-1 tactical_proposals row + a Lark DM to admin (Xingze)
// summarizing the proposal with a /api/tactical/<id>/decide link.
//
// Design choice (per user 2026-05-03): all personas see the SAME
// evidence pack — they differ only in their persona/goal. This is
// closer to how a real congress works (each senator reads the whole
// bill; differentiation is in their role, not their access).

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

interface Persona {
  key: string;
  display: string;
  system: string;
  question: string;
}

const ROSTER: Persona[] = [
  {
    key: "data_analyst",
    display: "Data Analyst",
    system: "你是 Qiji 算力 program 的 data analyst. 简洁, 用数字, 不下判断, 只报告.",
    question: "Looking at the evidence pack, what's the single most actionable metric movement this week? (rate change, drift count, anything quantitative). Don't propose changes — just call out the signal.",
  },
  {
    key: "copywriter",
    display: "Copywriter",
    system: "你是销售邮件文案. 关心邮件 prose, subject line, 模板的具体措辞. 不关心 routing 或 pipeline.",
    question: "Given the drift patterns and JITR accepts/dismisses, what's one prose-level change worth A/B testing? Be specific — exact subject line, exact phrase swap.",
  },
  {
    key: "academic_proxy",
    display: "Academic Proxy",
    system: "你代表收件人 — 一位中国 AI researcher. 你不是 sales, 你是 reader. 你看到这封邮件感觉怎么样.",
    question: "From the recipient's POV, what's the most off-putting or compelling thing about how we currently reach out? Cite specific replies if available.",
  },
  {
    key: "sales_director",
    display: "Sales Director",
    system: "你是 sales director — 关心 rep 的 workflow + 时间 + 信心. Helper bot 对话和 skip reason 是你的窗口.",
    question: "What friction are reps hitting that the Daily loop (JITR) can't fix on its own? Anything systemic that needs a tactical change — routing, template, batch behavior?",
  },
  {
    key: "psychologist",
    display: "Psychologist",
    system: "你是 psychologist — 看 emotional/cognitive state 我们 create 在 recipient 身上. 不是 Academic Proxy (那是 'reader 看到这封信怎么想'); 你是 'reader as human under social/professional pressure'. Status anxiety, imposter feelings, cold-outreach fatigue — those are你的 territory. 也包括 rep 的 心理 state — burnout signals, frustration patterns.",
    question: "Beyond what's read or clicked: what emotional response are we likely creating in the recipient? Are we triggering status anxiety, dismissiveness, or genuine curiosity? On the rep side — any signs of script-fatigue or burnout in helper bot conversations / skip reasons? Cite specifics.",
  },
  {
    key: "adversary",
    display: "Adversary",
    system: "你的工作是 attack 任何提议的改动. 假设其他 panelist 都太乐观.",
    question: "Read what the other panelists have said. Pick the strongest proposal implicit in their analysis and attack it: what's the most likely reason it WON'T lift conversion? Be specific.",
  },
  {
    key: "synthesizer",
    display: "Synthesizer",
    system: "你 synthesizes the panel into a concrete shippable proposal. JSON output only.",
    question: `Given the panel discussion, produce a JSON object with this shape:
{
  "title": "one-line summary",
  "change_spec": { "kind": "subject_line_test"|"template_phrase_swap"|"routing_tweak"|"copy_edit", "details": {} },
  "expected_lift": { "metric": "open_rate"|"click_rate"|"wechat_rate", "delta_pp": 0.0, "rationale": "" },
  "weeks_to_evaluate": 4,
  "skip_reason_if_no_proposal": null
}

If the panel consensus is "no shippable change this week," set skip_reason_if_no_proposal to a one-line reason and leave the other fields empty. DO NOT invent proposals. JSON only, no markdown fence.`,
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

  // ─── Evidence gather ────────────────────────────────────────────────
  async function buildEvidencePack(): Promise<string> {
    const lines: string[] = [];
    const constraints = await buildConstraintsPreamble();
    if (constraints) lines.push(constraints);

    lines.push(`## Week-over-week metrics (last 7d vs prior 7d)`);
    const now = Date.now();
    const wk = 7 * 24 * 3600 * 1000;
    const cur7 = new Date(now - wk).toISOString();
    const prev14 = new Date(now - 2 * wk).toISOString();

    for (const [label, range] of [["last 7d", [cur7, undefined]], ["prior 7d", [prev14, cur7]]] as const) {
      let q = sb.from("emails").select("id, status, created_at").gte("created_at", range[0]);
      if (range[1]) q = q.lt("created_at", range[1]);
      const { data } = await q;
      const sent = data?.length ?? 0;
      const opened = (data ?? []).filter((e: { status: string }) => e.status === "opened" || e.status === "clicked").length;
      const clicked = (data ?? []).filter((e: { status: string }) => e.status === "clicked").length;
      lines.push(`  ${label}: sent=${sent}, opened=${opened}, clicked=${clicked}`);
    }

    const { data: drifts } = await sb
      .from("prompt_drift_patterns")
      .select("ai_phrase, sales_phrase, occurrence_count, status")
      .order("occurrence_count", { ascending: false })
      .limit(10);
    if (drifts && drifts.length > 0) {
      lines.push(`\n## Recent drift patterns (rep edits to AI drafts)`);
      for (const d of drifts) lines.push(`  [${d.status}] x${d.occurrence_count}  "${(d.ai_phrase || "").slice(0, 50)}" → "${(d.sales_phrase || "").slice(0, 50)}"`);
    }

    const { data: offers } = await sb.from("jitr_offers").select("decision").gte("offered_at", cur7);
    const accepts = (offers ?? []).filter((o: { decision: string }) => o.decision === "accept").length;
    const dismisses = (offers ?? []).filter((o: { decision: string }) => o.decision === "dismiss").length;
    const pending = (offers ?? []).filter((o: { decision: string }) => o.decision === "pending").length;
    lines.push(`\n## JITR (Daily loop) signal — last 7d`);
    lines.push(`  accepts=${accepts}, dismisses=${dismisses}, pending=${pending}`);

    const { data: inbounds } = await sb
      .from("inbound_emails")
      .select("subject, body_snippet")
      .order("received_at", { ascending: false })
      .limit(8);
    if (inbounds && inbounds.length > 0) {
      lines.push(`\n## Recent inbound replies (sample for Academic Proxy)`);
      for (const i of inbounds) lines.push(`  "${(i.subject || "").slice(0, 60)}" — ${(i.body_snippet || "").slice(0, 100)}`);
    }

    return lines.join("\n");
  }

  async function runOnePersona(p: Persona, evidencePack: string, runningContext: string): Promise<string> {
    const userPrompt = `## Weekly Tactical Congress — your role: ${p.display}
${p.question}

## Shared evidence pack
${evidencePack}
${runningContext ? "\n## What other panelists have said so far\n" + runningContext : ""}

Speak in your role. 200 words max. Cite specific numbers/quotes from the evidence pack. Don't repeat what others said — push back, refine, or add what's missing.`;

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
      console.error(`persona ${p.key} failed:`, String(err).slice(0, 200));
      return `(persona errored: ${String(err).slice(0, 100)})`;
    }
  }

  console.log(`Loop 2 (Weekly Tactical Congress) starting${DRY_RUN ? " (DRY RUN)" : ""}`);

  const evidencePack = await buildEvidencePack();
  console.log(`evidence pack: ${evidencePack.length} chars`);
  if (DRY_RUN) console.log(`\n--- evidence ---\n${evidencePack.slice(0, 1500)}\n---\n`);

  const personas: Record<string, string> = {};
  let runningContext = "";
  for (const p of ROSTER) {
    console.log(`  ${p.display}...`);
    const text = await runOnePersona(p, evidencePack, runningContext);
    personas[p.key] = text;
    runningContext += `\n\n### ${p.display}\n${text}`;
  }

  let synthJson: {
    title?: string;
    change_spec?: object;
    expected_lift?: object;
    weeks_to_evaluate?: number;
    skip_reason_if_no_proposal?: string | null;
  };
  try {
    let raw = personas.synthesizer.trim();
    raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    synthJson = JSON.parse(raw);
  } catch (err) {
    console.error("Synthesizer did not return parseable JSON:", err);
    console.error("Raw:", personas.synthesizer.slice(0, 500));
    process.exit(DRY_RUN ? 0 : 1);
  }

  if (synthJson.skip_reason_if_no_proposal) {
    console.log(`\nNO PROPOSAL: ${synthJson.skip_reason_if_no_proposal}`);
  } else {
    console.log(`\nPROPOSAL: ${synthJson.title}`);
    console.log(`  change_spec: ${JSON.stringify(synthJson.change_spec).slice(0, 200)}`);
    console.log(`  expected_lift: ${JSON.stringify(synthJson.expected_lift)}`);
  }

  if (DRY_RUN) {
    console.log("\n(dry-run; not persisting or notifying)");
    return;
  }

  if (synthJson.skip_reason_if_no_proposal) {
    await notifyAdminText(`📋 Weekly Tactical Congress: no proposal this week.\nReason: ${synthJson.skip_reason_if_no_proposal}`);
    return;
  }

  const { data: row, error } = await sb.from("tactical_proposals").insert({
    title: synthJson.title!,
    deliberation: { personas, change_spec: synthJson.change_spec, evidence_pack_excerpt: evidencePack.slice(0, 2000) },
    change_spec: synthJson.change_spec!,
    expected_lift: synthJson.expected_lift,
    weeks_to_evaluate: synthJson.weeks_to_evaluate ?? 4,
  }).select().single();
  if (error || !row) {
    console.error("insert failed:", error?.message);
    process.exit(1);
  }
  console.log(`persisted: tactical_proposals.id=${row.id}`);

  // Send the interactive admin card (Accept / Reject / Open dashboard).
  // We still send the plain-text summary below as a fallback so the
  // change_spec JSON is in the chat scrollback for later reference.
  try {
    const { sendTacticalProposalCard } = await import("../src/lib/admin-approval-cards.ts");
    await sendTacticalProposalCard({
      proposal_id: row.id as string,
      title: synthJson.title!,
      rationale: (personas.adversary as string | undefined ?? "").slice(0, 1500),
    });
    console.log("admin card sent");
  } catch (e) {
    console.error("admin card failed (non-fatal):", e);
  }

  const summary = [
    `📋 Weekly Tactical Congress proposal`,
    ``,
    `Title: ${synthJson.title}`,
    `Expected lift: ${JSON.stringify(synthJson.expected_lift)}`,
    `Evaluate after: ${synthJson.weeks_to_evaluate ?? 4} weeks`,
    ``,
    `Change spec: ${JSON.stringify(synthJson.change_spec).slice(0, 300)}`,
    ``,
    `Adversary said: "${(personas.adversary || "").slice(0, 200)}"`,
    ``,
    `Approve / Reject: /api/tactical/${row.id}/decide?approved=1|0`,
  ].join("\n");
  await notifyAdminText(summary);
  console.log("admin notified");
}

main().catch((err) => { console.error(err); process.exit(1); });
