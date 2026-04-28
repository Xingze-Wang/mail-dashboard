import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { assembleDraft, type EmailTemplate } from "@/lib/template-assembler";
import { getRep } from "@/lib/assignment";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/templates/preview?templateId=&leadId=
 *
 * Renders a single lead through a specific template (not necessarily
 * the rep's active one). Lets admin sanity-check what a template
 * actually produces before activating it. Calls the same assembleDraft
 * code path as the live email-generator, so preview = production.
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const templateId = url.searchParams.get("templateId");
  const leadId = url.searchParams.get("leadId");
  if (!templateId || !leadId) {
    return NextResponse.json({ error: "templateId and leadId required" }, { status: 400 });
  }

  const [{ data: tplRow, error: tplErr }, { data: lead, error: leadErr }] = await Promise.all([
    supabase.from("email_templates").select("*").eq("id", templateId).maybeSingle(),
    supabase.from("pipeline_leads").select("title, abstract, author_name, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id").eq("id", leadId).maybeSingle(),
  ]);
  if (tplErr || !tplRow) return NextResponse.json({ error: "template not found" }, { status: 404 });
  if (leadErr || !lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });

  // Pull rep identity from the lead's assigned_rep_id when available;
  // falls back to "Leo / Lorenserus1" the same way email-generator
  // does so the preview matches what would actually go out.
  const rep = lead.assigned_rep_id != null ? await getRep(lead.assigned_rep_id) : null;

  const tpl: EmailTemplate = tplRow as unknown as EmailTemplate;

  // Preview is allowed to degrade gracefully when the LLM intro
  // step fails (Gemini 429, transient outages, etc). Production sends
  // surface those errors; preview doesn't need to — the structural
  // template is what we want to inspect, and a placeholder banner
  // makes the failure visible without blocking the page.
  let draft;
  let warning: string | null = null;
  try {
    draft = await assembleDraft(tpl, {
      title: (lead.title as string) ?? "(untitled)",
      abstract: (lead.abstract as string) ?? "",
      authorEmail: (lead.author_email as string) ?? "",
      firstName: (lead.first_name as string | null) ?? null,
      schoolName: (lead.school_name as string | null) ?? null,
      schoolTier: (lead.school_tier as number | null) ?? null,
      matchedDirections: Array.isArray(lead.matched_directions) ? (lead.matched_directions as string[]) : [],
      repName: rep?.sender_name ?? rep?.name ?? "Leo",
      repWechatId: rep?.wechat_id ?? "Lorenserus1",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warning = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    // Best-effort placeholder so admin still sees the structural
    // template (subject, body shell) without the LLM intro.
    draft = {
      subject: tpl.subject_format.replace("{{title}}", (lead.title as string) ?? "(untitled)").slice(0, 200),
      html: `<div style="padding:16px;border:1px dashed #fca5a5;background:#fef2f2;color:#991b1b;border-radius:6px">Preview degraded — LLM intro step failed (${warning ?? "unknown error"}). Structural template still loaded; production sends would either succeed or surface this same error.</div>`,
    };
  }

  return NextResponse.json({ subject: draft.subject, html: draft.html, warning });
}
