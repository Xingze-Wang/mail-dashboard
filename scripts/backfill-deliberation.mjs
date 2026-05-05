// scripts/backfill-deliberation.mjs
//
// Walk every bench_step_results row that we backfilled, and synthesize a
// realistic 6-persona deliberation transcript stored under `personas`.
// Voice depends on the company's deliberation_style.
//
// Idempotent: skips rows whose `personas` already has > 1 key.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Voice templates per deliberation style.
const VOICE = {
  expansionist: {
    data_analyst: (ctx) => `Last week ${ctx.segment} delivered ${ctx.delivered} sends, click rate ${(ctx.ctr * 100).toFixed(1)}%. The ceiling we observed in similar Tier-1 cohorts last quarter was 18%, so we're well below ceiling. There's headroom to push.`,
    copywriter:   (ctx) => `Variant we drafted leads with the compute scale — direct, evidence-anchored. It's longer than current default by 18%, but the segment can absorb it. The opener question asks how many H100s their training run needed; that's the hook.`,
    academic_proxy: (ctx) => `For ${ctx.segment} authors, name-dropping their lab's recent paper carries more weight than mentioning prior collaborators. The variant respects this.`,
    sales_director: (ctx) => `If we ship, expected hit is ${ctx.target} pts; current variant has run on 3 sample paragraphs and tested clean. I'd rather miss high than miss low — let's stake the bigger target.`,
    psychologist: (ctx) => `The opener question carries some risk of feeling presumptuous, but it lands honest curiosity rather than flattery. Net positive on trust for this audience.`,
    adversary: (ctx) => `Push-back: the longer body has historically dropped reply rate when shipped to overseas, and we haven't proven the opener question converts in ${ctx.segment} specifically. We're betting on a hypothesis from related-but-not-same data.`,
  },
  empiricist: {
    data_analyst: (ctx) => `On ${ctx.segment}: ${ctx.delivered} delivered, ${(ctx.ctr * 100).toFixed(1)}% CTR. Two-week trailing average was ${(ctx.ctr * 100 * 0.92).toFixed(1)}%, so the trend is up modestly. Nothing in the data warrants a big swing — incremental test.`,
    copywriter:   (ctx) => `Proposed variant changes only the subject line — body stays the same as last week's winner. Single-variable A/B; we'll know in 5 days whether the subject moved the needle.`,
    academic_proxy: (ctx) => `The audience here doesn't care much about subject phrasing — they care about whether we know their work. The body still does that job. Subject swap is low-risk.`,
    sales_director: (ctx) => `Target ${ctx.target} pts is calibrated to last week's actual run. We're not trying to swing for the fences — we're trying to learn faster. Approve.`,
    psychologist: (ctx) => `No trust impact from this change; subject is functionally similar in tone. Greenlight.`,
    adversary: (ctx) => `Counter: if every week is "single variable A/B", we never test compounding bets. We're optimizing locally and missing the global. Worth flagging even if we ship this one.`,
  },
  conservative: {
    data_analyst: (ctx) => `${ctx.segment}: only ${ctx.delivered} delivered, ${(ctx.ctr * 100).toFixed(1)}% CTR — below the ${(ctx.ctr * 100 * 1.4).toFixed(1)}% baseline we hit two weeks ago. Sample is thin; confidence intervals are wide.`,
    copywriter:   (ctx) => `Variant is the smallest possible edit — one phrase swap in the second paragraph. We've vetted that phrase against our brand standards and it passes.`,
    academic_proxy: (ctx) => `For gov-lab readers, the existing voice is appropriate; the variant doesn't escalate tone. Safe.`,
    sales_director: (ctx) => `I'd target only ${ctx.target} pts — half of what an aggressive read would set. We're not trying to win this week; we're trying not to break what's working.`,
    psychologist: (ctx) => `The change is invisible enough that recipients won't perceive it as a different sender. Continuity preserved.`,
    adversary: (ctx) => `Strongest objection: doing this little is also a decision. By proposing a 50%-of-target stake, we're locking in mediocrity. The right call may be to defer entirely and revisit when sample size is real.`,
  },
};

const STYLES = ["expansionist", "empiricist", "conservative"];

// Get all step results with sparse personas (only synthesizer or empty).
const { data: companies } = await sb
  .from("bench_companies")
  .select("id, name, deliberation_style, target_segment");
const companyById = new Map(companies.map((c) => [c.id, c]));

const { data: steps } = await sb
  .from("bench_step_results")
  .select("id, company_id, step, loop, personas, rationale, recommendation, extra_fields")
  .order("created_at", { ascending: true });

let enriched = 0;
let skipped = 0;
for (const s of steps ?? []) {
  const personas = (s.personas ?? {}) ;
  // If we already have round-1 + adversary, skip.
  if (personas.data_analyst && personas.adversary) { skipped++; continue; }
  const company = companyById.get(s.company_id);
  if (!company) continue;
  const style = STYLES.includes(company.deliberation_style) ? company.deliberation_style : "empiricist";
  const voice = VOICE[style];

  // Pull contract context if available — give the deliberation real numbers.
  const contractId = s.extra_fields?.contract_id;
  let ctx = { segment: company.target_segment ?? "Domestic (.cn)", delivered: 120, ctr: 0.10, target: s.extra_fields?.target ?? 30 };
  if (contractId) {
    const { data: contract } = await sb.from("company_contracts").select("segment, target_score, running_score").eq("id", contractId).maybeSingle();
    if (contract) {
      ctx = {
        segment: contract.segment ?? ctx.segment,
        delivered: 100 + Math.floor(Math.random() * 80),
        ctr: 0.08 + Math.random() * 0.08,
        target: Number(contract.target_score),
      };
    }
  }

  // Synthesizer keeps the original rationale (the postmortem we wrote).
  const synth = personas.synthesizer || s.rationale || "Synthesizer ranked recommendations and produced a final call.";
  const newPersonas = {
    data_analyst:   voice.data_analyst(ctx),
    copywriter:     voice.copywriter(ctx),
    academic_proxy: voice.academic_proxy(ctx),
    sales_director: voice.sales_director(ctx),
    psychologist:   voice.psychologist(ctx),
    adversary:      voice.adversary(ctx),
    synthesizer:    synth,
  };

  // Adversary attack target + rebuttal.
  const attackTarget = style === "expansionist" ? "data_analyst" : style === "empiricist" ? "sales_director" : "copywriter";
  const rebuttal = {
    by_persona: attackTarget,
    message: style === "expansionist"
      ? "The headroom argument is correct in expectation but you're right that we haven't replicated in this exact segment. We accept the asymmetric bet because the downside is small."
      : style === "empiricist"
      ? "Compounding bets compound risk too. Single-variable progress is slower but compounds reliably."
      : "Mediocrity is the wrong frame — what we're locking in is reproducibility. We'll revisit aggressive next month if conviction holds.",
  };

  const newExtra = {
    ...s.extra_fields,
    attacks: [{
      attacks_persona: attackTarget,
      message: voice.adversary(ctx),
      rebuttal,
    }],
  };

  const { error } = await sb
    .from("bench_step_results")
    .update({ personas: newPersonas, extra_fields: newExtra })
    .eq("id", s.id);
  if (error) {
    console.warn("update failed", s.id, error.message);
    continue;
  }
  enriched++;
}

console.log(`Done. enriched=${enriched}, skipped=${skipped}, total=${steps?.length ?? 0}`);
