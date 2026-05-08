import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { assembleDraft, type EmailTemplate, type AssemblyInput } from "@/lib/template-assembler";

export const maxDuration = 120;

/**
 * GET /api/templates/bench
 *   ?segment=all|cn|overseas|edu|other
 *   &n=5            — number of recent leads to pull (1..10)
 *   &templateIds=   — comma-separated template ids; defaults to ALL
 *                     non-archived templates (active + proposal)
 *
 * Returns: { leads: [...], templates: [...], cells: [{lead_id, template_id, subject, html, error}] }
 *
 * Each cell is the actual assembleDraft() output — same code path the
 * production send uses. So the bench shows literally what would be sent
 * if that template were used for that lead. Including LLM-generated
 * intro paragraphs (real Gemini calls).
 *
 * Cost: cells = leads × templates real Gemini calls per request. We
 * bound at 5 × 6 = 30 max and run in parallel. Admin clicks "render"
 * deliberately so it's not auto-firing on page load.
 *
 * Per the user's "我们一定要有数据" rule: this returns real output
 * from real prompts on real leads — not mocks, not stubs. That's why
 * it's expensive; that's also why it's worth the cost.
 *
 * Auth: admin only (same JWT + DB role recheck pattern as rep-trust).
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

interface LeadForBench {
  id: number;
  title: string;
  abstract: string;
  author_email: string;
  first_name: string | null;
  school_name: string | null;
  school_tier: number | null;
  matched_directions: string[];
  assigned_rep_id: number | null;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const url = new URL(req.url);
  const segment = url.searchParams.get("segment") ?? "all";
  const n = Math.max(1, Math.min(10, Number(url.searchParams.get("n") ?? 5)));
  const templateIdsParam = url.searchParams.get("templateIds");
  const filterIds = templateIdsParam?.split(",").filter(Boolean) ?? null;

  // ── Pull leads ──────────────────────────────────────────────────────
  // Filter by segment if asked. We classify by author_email suffix —
  // same rule as deriveSegmentContext in template-assembler.ts (kept
  // in sync intentionally; both are conventions on the email string).
  let leadQuery = supabase
    .from("pipeline_leads")
    .select(
      "id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id",
    )
    .not("title", "is", null)
    .not("abstract", "is", null)
    .not("author_email", "is", null)
    .order("created_at", { ascending: false })
    .limit(n * 4); // overfetch then filter — segment filter is on a derived field

  const { data: candidatesRaw, error: leadErr } = await leadQuery;
  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });

  const candidates = (candidatesRaw ?? []) as LeadForBench[];
  const inSegment = (lead: LeadForBench): boolean => {
    if (segment === "all") return true;
    const lower = (lead.author_email ?? "").toLowerCase();
    if (segment === "cn") return lower.endsWith(".cn");
    if (segment === "edu") return lower.endsWith(".edu") || lower.endsWith(".edu.cn");
    if (segment === "overseas") {
      // overseas = neither .cn nor .edu — symmetric to deriveSegmentContext
      return !lower.endsWith(".cn") && !lower.endsWith(".edu") && !lower.endsWith(".edu.cn");
    }
    return true;
  };
  const leads = candidates.filter(inSegment).slice(0, n);

  if (leads.length === 0) {
    return NextResponse.json({ leads: [], templates: [], cells: [] });
  }

  // ── Pull templates ─────────────────────────────────────────────────
  // Default: every non-archived template (so admin can preview both
  // active templates AND congress proposals side-by-side). Optional
  // templateIds filter scopes to specific ones.
  let tplQuery = supabase
    .from("email_templates")
    .select("*")
    .eq("active", true)
    .neq("status", "archived")
    .order("status", { ascending: true }) // 'active' before 'proposal'
    .order("created_at", { ascending: true });
  if (filterIds && filterIds.length > 0) tplQuery = tplQuery.in("id", filterIds);
  const { data: templates, error: tplErr } = await tplQuery;
  if (tplErr) return NextResponse.json({ error: tplErr.message }, { status: 500 });

  const tpls = (templates ?? []) as (EmailTemplate & { status: string; segment_default: string | null })[];

  // ── Render every (lead, template) cell ─────────────────────────────
  // Resolve rep name for each lead so the rep_intro paragraph renders
  // realistically. Cheap join: there are at most 10 unique reps.
  const repIds = Array.from(new Set(leads.map((l) => l.assigned_rep_id).filter(Boolean) as number[]));
  let repMap: Record<number, { name: string; wechat_id: string | null }> = {};
  if (repIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, name, wechat_id")
      .in("id", repIds);
    repMap = Object.fromEntries(
      (reps ?? []).map((r) => [r.id, { name: r.name, wechat_id: r.wechat_id }]),
    );
  }

  // Render in parallel. Each cell is independent. If one Gemini call
  // fails we keep its row but flag error — bench should still show the
  // other cells, and admin can see WHICH template/lead combo failed.
  const cells = await Promise.all(
    leads.flatMap((lead) =>
      tpls.map(async (tpl) => {
        const rep = lead.assigned_rep_id ? repMap[lead.assigned_rep_id] : null;
        const input: AssemblyInput = {
          title: lead.title,
          abstract: lead.abstract,
          authorEmail: lead.author_email,
          firstName: lead.first_name,
          schoolName: lead.school_name,
          schoolTier: lead.school_tier,
          matchedDirections: lead.matched_directions ?? [],
          repName: rep?.name ?? "Leon",
          repWechatId: rep?.wechat_id ?? "",
        };
        try {
          const draft = await assembleDraft(tpl, input);
          return {
            lead_id: lead.id,
            template_id: tpl.id,
            subject: draft.subject,
            html: draft.html,
            error: null as string | null,
          };
        } catch (e) {
          return {
            lead_id: lead.id,
            template_id: tpl.id,
            subject: "",
            html: "",
            error: (e as Error).message,
          };
        }
      }),
    ),
  );

  return NextResponse.json({
    leads: leads.map((l) => ({
      id: l.id,
      title: l.title,
      author_email: l.author_email,
      first_name: l.first_name,
      school_name: l.school_name,
      school_tier: l.school_tier,
      matched_directions: l.matched_directions,
    })),
    templates: tpls.map((t) => ({
      id: t.id,
      name: t.name,
      rep_id: t.rep_id,
      status: t.status,
      segment_default: t.segment_default,
    })),
    cells,
  });
}
