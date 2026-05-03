// Shared congress utilities — used by Loops 2/3/4.
//
// Each loop is a sequence of: gather evidence → run personas → synthesize
// → persist → notify admin. The persona-call mechanics are identical
// across loops; only the evidence-gather and roster differ. This file
// holds the shared pieces so the runners stay short and inspectable.

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";

export interface PersonaSpec {
  key: string;            // e.g. "data_analyst" — becomes JSON key in deliberation
  display: string;        // human-facing name on Lark cards
  system: string;         // persona-specific system prompt
  question: string;       // the one question this persona answers given evidence
}

export interface DeliberationResult {
  personas: Record<string, string>;   // key → text response
  meta: { model: string; total_ms: number };
}

export async function runDeliberation(
  personas: PersonaSpec[],
  evidencePack: string,
  loopName: string,
): Promise<DeliberationResult> {
  const t0 = Date.now();
  const result: Record<string, string> = {};
  let modelUsed = "";

  // Run personas SERIALLY so each can see prior personas' contributions
  // (matches actual congress dynamics: panel speaks in order, each builds
  // on what was just said). Adversary should ALWAYS go right before
  // Synthesizer — that ordering is enforced in the loop runner's roster.
  let runningContext = "";
  for (const p of personas) {
    const userPrompt = `## ${loopName} congress — your role: ${p.display}
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
        max_tokens: 800,
      });
      const text = r.text?.trim() ?? "(empty)";
      result[p.key] = text;
      modelUsed = r.meta?.model ?? "gemini-3-flash";
      runningContext += `\n\n### ${p.display}\n${text}`;
    } catch (err) {
      console.error(`[congress/${loopName}] persona ${p.key} failed:`, err);
      result[p.key] = `(persona errored: ${String(err).slice(0, 100)})`;
    }
  }

  return { personas: result, meta: { model: modelUsed, total_ms: Date.now() - t0 } };
}

// Send an admin notification via Lark text DM. Used by all loops.
// Returns ok/error so caller can decide how loud to be on failure.
export async function notifyAdminText(text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: admin } = await supabase
      .from("sales_reps")
      .select("lark_open_id")
      .eq("id", 5)
      .maybeSingle();
    if (!admin?.lark_open_id) return { ok: false, error: "admin not lark-bound" };

    const appId = process.env.LARK_APP_ID;
    const secret = process.env.LARK_APP_SECRET;
    if (!appId || !secret) return { ok: false, error: "lark creds missing" };
    const base = process.env.LARK_REGION === "cn"
      ? "https://open.feishu.cn/open-apis"
      : "https://open.larksuite.com/open-apis";

    const tokRes = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: secret }),
      signal: AbortSignal.timeout(20_000),
    });
    const tokJson = await tokRes.json();
    if (tokJson.code !== 0) return { ok: false, error: `token: ${JSON.stringify(tokJson).slice(0, 100)}` };

    const sendRes = await fetch(`${base}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokJson.tenant_access_token}` },
      body: JSON.stringify({
        receive_id: admin.lark_open_id,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok || j.code !== 0) return { ok: false, error: `send: ${sendRes.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

// Build the "constraints" preamble injected into Loop 2/3 prompts so
// strategic directives + unresolved incident lessons are always
// in scope. This is the make-or-break link between loops.
export async function buildConstraintsPreamble(): Promise<string> {
  const lines: string[] = [];

  const { data: directives } = await supabase
    .from("strategic_directives")
    .select("body, effective_from")
    .eq("active", true)
    .or("effective_until.is.null,effective_until.gt.now")
    .order("effective_from", { ascending: false })
    .limit(10);
  if (directives && directives.length > 0) {
    lines.push("## ACTIVE STRATEGIC DIRECTIVES (set by Monthly congress)");
    for (const d of directives) lines.push(`- ${d.body}`);
  }

  const { data: lessons } = await supabase
    .from("incident_lessons")
    .select("trigger_kind, narrative, detected_at")
    .is("resolved_at", null)
    .order("detected_at", { ascending: false })
    .limit(5);
  if (lessons && lessons.length > 0) {
    lines.push("\n## OPEN INCIDENT LESSONS (unresolved postmortems)");
    for (const l of lessons) lines.push(`- [${l.trigger_kind}] ${l.narrative.slice(0, 200)}`);
  }

  return lines.length > 0 ? lines.join("\n") + "\n\n" : "";
}
