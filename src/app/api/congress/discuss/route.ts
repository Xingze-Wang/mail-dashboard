// POST /api/congress/discuss
// Streams a live council deliberation for a given evidence pack.
// The client receives newline-delimited JSON chunks, one per persona turn.
// Each chunk: { persona: string, text: string, done: boolean }
//
// Request body: { proposalId?: string, evidenceText?: string, title?: string }
// If proposalId is given, evidence is loaded from tactical_proposals.deliberation.
// If evidenceText is given directly, it's used as the evidence pack.
// Falls back to bench sample 0 if neither is present.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";
import { CONGRESS_SAMPLES } from "@/lib/bench-congress";

export const maxDuration = 300;

const PERSONAS = [
  { key: "data_analyst",  label: "Data Analyst",    role: "enforces statistical reality" },
  { key: "copywriter",    label: "Copywriter",       role: "tone & top-of-funnel quality" },
  { key: "academic_proxy",label: "Academic Proxy",   role: "advocates for the researcher's perspective" },
  { key: "sales_director",label: "Sales Director",   role: "bottom-of-funnel conversion focus" },
  { key: "psychologist",  label: "Psychologist",     role: "emotional capital and rep wellbeing" },
  { key: "adversary",     label: "Adversary",        role: "challenges every claim to find weaknesses" },
  { key: "synthesizer",   label: "Synthesizer",      role: "produces final ranked recommendation" },
] as const;

function buildPersonaPrompt(
  persona: typeof PERSONAS[number],
  title: string,
  evidence: string,
  priorTurns: { label: string; text: string }[],
): string {
  const history = priorTurns.length === 0 ? "" : `
## 前面委员的发言
${priorTurns.map((t) => `**${t.label}**: ${t.text}`).join("\n\n")}
`;

  const isSynthesizer = persona.key === "synthesizer";
  const instruction = isSynthesizer
    ? `作为${persona.label}（${persona.role}），综合上面所有委员的意见，给出最终建议：approve、reject 或 defer，并说明理由（2-3句）。`
    : `作为${persona.label}（${persona.role}），对这个提案发表你的看法（2-4句）。要简洁、有见地、站在你的角色立场上。`;

  return `你是销售邮件策略委员会的一员，正在讨论以下提案。

## 提案
标题：${title}

## 证据
${evidence}
${history}
## 你的任务
${instruction}

只返回你的发言，不要角色名或前缀。`;
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const model: string = body.model ?? "claude-sonnet-4.6";

  let title: string;
  let evidence: string;

  if (body.proposalId) {
    const { data: row } = await supabase
      .from("tactical_proposals")
      .select("title, deliberation")
      .eq("id", body.proposalId)
      .maybeSingle();
    title = row?.title ?? "Unnamed proposal";
    evidence = row?.deliberation?.evidence_pack_excerpt ?? "(no evidence pack stored)";
  } else if (body.evidenceText && body.title) {
    title = body.title;
    evidence = body.evidenceText;
  } else {
    // Fall back to bench sample 0
    const s = CONGRESS_SAMPLES[body.sampleIdx ?? 0] ?? CONGRESS_SAMPLES[0];
    title = s.title;
    evidence = s.evidence;
  }

  // Stream personas one by one, each as a JSON line
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const priorTurns: { label: string; text: string }[] = [];

      for (const persona of PERSONAS) {
        try {
          const prompt = buildPersonaPrompt(persona, title, evidence, priorTurns);
          const r = await llmChat({
            model,
            user: prompt,
            temperature: persona.key === "synthesizer" ? 0.3 : 0.7,
            max_tokens: 400,
            timeoutMs: 60_000,
          });
          const text = r.text.trim();
          priorTurns.push({ label: persona.label, text });
          const chunk = JSON.stringify({ persona: persona.key, label: persona.label, text, done: false });
          controller.enqueue(encoder.encode(chunk + "\n"));
        } catch (e) {
          const errText = e instanceof Error ? e.message.slice(0, 200) : String(e);
          const chunk = JSON.stringify({ persona: persona.key, label: persona.label, text: `[error: ${errText}]`, done: false, error: true });
          controller.enqueue(encoder.encode(chunk + "\n"));
        }
      }

      // Final done marker
      controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
      controller.close();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
