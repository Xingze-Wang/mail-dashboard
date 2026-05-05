// POST /api/proposals/demo — synthesize a real, in-character proposal
// from a specific company. The LLM call uses the company's
// deliberation_style + thesis + target_segment so three companies produce
// three distinctly-voiced proposals.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";
import { submitProposal, type ProposalKind } from "@/lib/proposals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4.6";

const STYLE_GUIDE: Record<string, string> = {
  expansionist: "Expansionist — willing to ship a bold variant on partial evidence; tolerates miss for chance at outsized hit. Voice is direct and ambitious.",
  empiricist:   "Empiricist — single-variable A/B; refuses to compound bets; trusts the next 7 days more than any prior. Voice is measured and procedural.",
  conservative: "Conservative — defers when sample is thin; smallest viable edit; prefers to preserve continuity. Voice is restrained and cautious.",
  balanced:     "Balanced — weighs both sides; ships modest changes when evidence is mixed.",
};

const SYSTEM = `You are an advisory company that proposes a single change to the sales floor's email program. Your output must reflect your deliberation style.

Output strict JSON. Schema:
{
  "kind": "subject_test" | "draft_revise" | "lead_skip" | "routing_rule" | "pacing_change",
  "prediction": string (1-2 sentences — the bet you're making, in your voice. Concrete numbers. NO partner names.),
  "payload": {
    // For subject_test: { current_subject: string, proposed_subject: string, segment: string, hypothesis: string }
    // For draft_revise: { lead_id: "synthetic-demo", current_draft: string, proposed_draft: string, reason: string, segment: string }
    // For lead_skip:    { lead_id: "synthetic-demo", reason: string }
    // For routing_rule: { rule: string, segment: string }
    // For pacing_change:{ delta: string, segment: string }
  }
}

The voice must match your style. Different style → different proposal kind, different prediction phrasing, different conviction level. NO partner names, NO "尊敬的", NO "您".`;

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.company_id) return NextResponse.json({ error: "company_id required" }, { status: 400 });

  const { data: company } = await supabase
    .from("bench_companies")
    .select("id, name, deliberation_style, thesis, target_segment")
    .eq("id", body.company_id)
    .maybeSingle();
  if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

  const styleNote = STYLE_GUIDE[company.deliberation_style as string] ?? STYLE_GUIDE.balanced;
  const userPrompt = JSON.stringify({
    company_name: company.name,
    deliberation_style: company.deliberation_style,
    style_guide: styleNote,
    thesis: company.thesis ?? "",
    target_segment: company.target_segment ?? "Domestic (.cn)",
    instruction: "Produce ONE proposal in your voice. Be specific. Do not hedge.",
  });

  let parsed: { kind: string; prediction: string; payload: Record<string, unknown> } | null = null;
  try {
    const out = await llmChat({
      model: MODEL,
      system: SYSTEM,
      user: userPrompt,
      json: true,
      max_tokens: 700,
      temperature: 0.6,
      timeoutMs: 35_000,
    });
    parsed = JSON.parse(out.text);
  } catch (err) {
    return NextResponse.json({ error: `LLM failed: ${String(err).slice(0, 200)}` }, { status: 502 });
  }
  if (!parsed?.kind || !parsed.payload) {
    return NextResponse.json({ error: "LLM returned malformed proposal" }, { status: 502 });
  }

  const validKinds: ProposalKind[] = ["subject_test", "draft_revise", "lead_skip", "routing_rule", "pacing_change"];
  if (!validKinds.includes(parsed.kind as ProposalKind)) {
    return NextResponse.json({ error: `Unknown kind ${parsed.kind}` }, { status: 502 });
  }

  const result = await submitProposal({
    company_id: company.id as string,
    kind: parsed.kind as ProposalKind,
    payload: parsed.payload,
    prediction: parsed.prediction ?? "",
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
