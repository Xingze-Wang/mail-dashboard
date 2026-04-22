import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { DEFAULT_INTRO_PROMPT, DEFAULT_INTRO_PROMPT_NAME } from "@/lib/email-generator";

const PATCH_BLOCK_HEADER = "## 销售反馈规则 (auto-generated, do not hand-edit)";
const PATCH_BLOCK_FOOTER = "## /销售反馈规则";

/**
 * POST /api/drift/patterns/[id]
 * Body: { action: "accept" | "ignore" }
 *
 * On "accept": flips status, stamps accepted_at/by, AND appends prompt_patch
 * to the pipeline_intro_prompt template (between sentinels) so future drafts
 * pick it up. We only auto-apply patches with rep_id=null (global) — per-rep
 * patches stay accepted but aren't wired into the shared prompt yet.
 *
 * On "ignore": just flips status. Useful for "saw it, not worth a rule" cases
 * (e.g. one-off taste edits we don't want re-mined every cycle).
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const session = gate.session;

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = body.action as "accept" | "ignore" | undefined;
  if (action !== "accept" && action !== "ignore") {
    return NextResponse.json({ error: "action must be 'accept' or 'ignore'" }, { status: 400 });
  }

  const { data: pattern, error: fetchErr } = await supabase
    .from("prompt_drift_patterns")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchErr || !pattern) {
    return NextResponse.json({ error: "Pattern not found" }, { status: 404 });
  }

  const newStatus = action === "accept" ? "accepted" : "ignored";
  const { error: updErr } = await supabase
    .from("prompt_drift_patterns")
    .update({
      status: newStatus,
      accepted_at: new Date().toISOString(),
      accepted_by: session.email ?? session.repName ?? "admin",
    })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Auto-wire only global, accepted patches with a non-empty patch string.
  let patchApplied = false;
  if (action === "accept" && pattern.rep_id === null && typeof pattern.prompt_patch === "string" && pattern.prompt_patch.trim()) {
    patchApplied = await appendPatchToTemplate(String(pattern.prompt_patch).trim(), String(pattern.ai_phrase ?? ""));
  }

  return NextResponse.json({ ok: true, status: newStatus, patchApplied });
}

/**
 * Appends a single patch line to the pipeline_intro_prompt template's
 * "销售反馈规则" block. Idempotent — if the same line already exists, it's a
 * no-op. Creates the block if missing. We tag each line with the originating
 * ai_phrase so a future "remove patch" UI can find it.
 */
async function appendPatchToTemplate(patch: string, aiPhrase: string): Promise<boolean> {
  const { data: tmpl } = await supabase
    .from("templates")
    .select("id, html")
    .eq("name", DEFAULT_INTRO_PROMPT_NAME)
    .limit(1)
    .maybeSingle();

  // If the row doesn't exist we seed with the full hardcoded default —
  // otherwise we'd overwrite a "missing override" with just the rules
  // block and destroy the prompt. loadPromptTemplate() only falls back to
  // DEFAULT_INTRO_PROMPT when the row is absent, not when it's truncated.
  const current = (tmpl?.html as string | null) ?? DEFAULT_INTRO_PROMPT;

  const tag = `<!-- ai_phrase: ${aiPhrase.replace(/-->/g, "—>").slice(0, 120)} -->`;
  const newLine = `- ${patch}  ${tag}`;

  if (current.includes(newLine)) return false; // exact dupe
  if (current.includes(tag)) return false; // same source already patched

  let next: string;
  if (current.includes(PATCH_BLOCK_HEADER)) {
    // Insert before the footer
    next = current.replace(PATCH_BLOCK_FOOTER, `${newLine}\n${PATCH_BLOCK_FOOTER}`);
  } else {
    next = `${current}\n\n${PATCH_BLOCK_HEADER}\n${newLine}\n${PATCH_BLOCK_FOOTER}\n`;
  }

  // Update if we found a row, otherwise insert one. We skip upsert because
  // the templates table's unique constraint isn't guaranteed to be on `name`.
  if (tmpl?.id) {
    const { error } = await supabase
      .from("templates")
      .update({ html: next, updated_at: new Date().toISOString() })
      .eq("id", tmpl.id);
    return !error;
  }
  const { error } = await supabase
    .from("templates")
    .insert({ name: DEFAULT_INTRO_PROMPT_NAME, html: next, subject: "pipeline_intro_prompt" });
  return !error;
}
