import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { assembleDraft, type EmailTemplate } from "@/lib/template-assembler";

export const maxDuration = 60;

/**
 * GET /api/templates/[id]/inspect
 *   ?lead_ids=<uuid,uuid,uuid>  — render against specific leads
 *   ?n=<int 1..10>              — count of "golden" leads to load
 *                                 (default 5; ignored if lead_ids set)
 *   ?segment=cn|overseas|edu|all (default 'all')
 *
 * Renders one template against N real leads AND returns per-part
 * provenance for each rendering. Per user feedback: 'inspect should
 * load against many real leads, not just one'.
 *
 * The golden set is the most-recent N leads with assigned_rep_id, in
 * the chosen segment. This way inspect shows variety (different schools,
 * different paper topics) without admin having to pick leads.
 *
 * Each rendering call to assembleDraft is wrapped in try/catch — one
 * Gemini failure doesn't 500 the whole response. Per-cell errors
 * surface as `error` fields in the lead's render payload so the UI
 * can show "this lead failed; here's why" without losing the others.
 *
 * Auth: admin only.
 */
async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

/**
 * Parse matched_directions which arrives from Postgres as either a
 * JSON-stringified array or a comma-delimited string. Defensive
 * because both shapes exist in the wild — Python scanner sometimes
 * writes one, sometimes the other.
 */
function parseDirections(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      // fall through
    }
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

interface LeadRow {
  id: string;
  title: string;
  abstract: string;
  author_email: string;
  first_name: string | null;
  school_name: string | null;
  school_tier: number | null;
  matched_directions: unknown;
  assigned_rep_id: number | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const url = new URL(req.url);
  const leadIdsParam = url.searchParams.get("lead_ids");
  const n = Math.max(1, Math.min(10, Number(url.searchParams.get("n") ?? 5)));
  const segment = url.searchParams.get("segment") ?? "all";

  const { data: tpl } = await supabase
    .from("email_templates")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!tpl) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  // ─── Pick leads ────────────────────────────────────────────────────
  // If lead_ids is supplied, use exactly those. Otherwise pull a
  // golden set: most-recent N leads with assigned_rep_id, optionally
  // filtered by segment via author_email TLD.
  let leads: LeadRow[] = [];
  if (leadIdsParam) {
    const ids = leadIdsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const { data } = await supabase
      .from("pipeline_leads")
      .select(
        "id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id",
      )
      .in("id", ids);
    leads = (data ?? []) as LeadRow[];
  } else {
    // Pull more than n to allow segment filtering in JS.
    const { data } = await supabase
      .from("pipeline_leads")
      .select(
        "id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id",
      )
      .not("assigned_rep_id", "is", null)
      .not("title", "is", null)
      .not("abstract", "is", null)
      .order("created_at", { ascending: false })
      .limit(n * 4);
    const all = (data ?? []) as LeadRow[];
    const inSegment = (l: LeadRow): boolean => {
      if (segment === "all") return true;
      const lower = (l.author_email ?? "").toLowerCase();
      if (segment === "cn") return lower.endsWith(".cn");
      if (segment === "edu") return lower.endsWith(".edu") || lower.endsWith(".edu.cn");
      if (segment === "overseas") {
        return !lower.endsWith(".cn") && !lower.endsWith(".edu") && !lower.endsWith(".edu.cn");
      }
      return true;
    };
    leads = all.filter(inSegment).slice(0, n);
  }
  if (leads.length === 0) {
    return NextResponse.json({ error: "No leads available" }, { status: 404 });
  }

  // ─── Resolve all rep identities in one round trip ─────────────────
  const repIds = Array.from(
    new Set(leads.map((l) => l.assigned_rep_id).filter((v): v is number => typeof v === "number")),
  );
  const repById = new Map<number, { name: string; wechat: string }>();
  if (repIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, sender_name, name, wechat_id")
      .in("id", repIds);
    for (const r of reps ?? []) {
      repById.set(r.id as number, {
        name: ((r.sender_name as string | null) ?? (r.name as string | null) ?? "Leon") as string,
        wechat: ((r.wechat_id as string | null) ?? "") as string,
      });
    }
  }

  // ─── Render in parallel, fault-tolerant per cell ──────────────────
  const renderings = await Promise.all(
    leads.map(async (lead) => {
      const aid = lead.assigned_rep_id;
      const rep = aid != null ? repById.get(aid) : null;
      const repName = rep?.name ?? "Leon";
      const repWechat = rep?.wechat ?? "";
      try {
        const draft = await assembleDraft(tpl as EmailTemplate, {
          title: lead.title,
          abstract: lead.abstract,
          authorEmail: lead.author_email,
          firstName: lead.first_name,
          schoolName: lead.school_name,
          schoolTier: lead.school_tier,
          matchedDirections: parseDirections(lead.matched_directions),
          repName,
          repWechatId: repWechat,
        });
        return {
          lead: {
            id: lead.id,
            title: lead.title,
            author_email: lead.author_email,
            first_name: lead.first_name,
            school_name: lead.school_name,
            school_tier: lead.school_tier,
            matched_directions: parseDirections(lead.matched_directions),
            assigned_rep: { name: repName, wechat: repWechat },
          },
          rendered: { subject: draft.subject, html: draft.html },
          parts: draft.parts,
          intro_prompt_resolved: draft.introPromptResolved,
          intro_output: draft.introOutput,
          error: null as string | null,
        };
      } catch (e) {
        return {
          lead: {
            id: lead.id,
            title: lead.title,
            author_email: lead.author_email,
            first_name: lead.first_name,
            school_name: lead.school_name,
            school_tier: lead.school_tier,
            matched_directions: parseDirections(lead.matched_directions),
            assigned_rep: { name: repName, wechat: repWechat },
          },
          rendered: null,
          parts: null,
          intro_prompt_resolved: null,
          intro_output: null,
          error: (e as Error).message,
        };
      }
    }),
  );

  return NextResponse.json({
    template: {
      id: tpl.id,
      name: tpl.name,
      status: tpl.status,
      segment_default: tpl.segment_default,
    },
    renderings,
  });
}
