/**
 * Test the multi-lead inspect route LOGIC end-to-end. Mirrors what
 * /api/templates/[id]/inspect does (without HTTP/auth) so we can
 * verify all 5 cells render without WAF/network getting in the way.
 */
import { assembleDraft, type EmailTemplate } from "../src/lib/template-assembler";
import { supabase } from "../src/lib/db";

function parseDirections(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try { const arr = JSON.parse(trimmed); return Array.isArray(arr) ? arr.map(String) : []; }
    catch { /* fall through */ }
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const N = 5;
  const SEGMENT = "all"; // most permissive
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("*")
    .eq("name", "global")
    .eq("active", true)
    .maybeSingle();
  if (!tpl) throw new Error("no global template");

  const { data: leads } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id")
    .not("assigned_rep_id", "is", null)
    .not("title", "is", null)
    .not("abstract", "is", null)
    .order("created_at", { ascending: false })
    .limit(N);
  if (!leads) throw new Error("no leads");
  console.log(`Got ${leads.length} leads`);
  void SEGMENT;

  const repIds = Array.from(new Set(leads.map((l) => l.assigned_rep_id).filter((v): v is number => typeof v === "number")));
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, sender_name, name, wechat_id")
    .in("id", repIds);
  const repById = new Map<number, { name: string; wechat: string }>();
  for (const r of reps ?? []) {
    repById.set(r.id as number, {
      name: ((r.sender_name as string | null) ?? (r.name as string | null) ?? "Leon") as string,
      wechat: ((r.wechat_id as string | null) ?? "") as string,
    });
  }

  const t0 = Date.now();
  const results = await Promise.all(leads.map(async (lead) => {
    const aid = lead.assigned_rep_id;
    const rep = aid != null ? repById.get(aid) : null;
    try {
      const draft = await assembleDraft(tpl as EmailTemplate, {
        title: lead.title, abstract: lead.abstract, authorEmail: lead.author_email,
        firstName: lead.first_name, schoolName: lead.school_name, schoolTier: lead.school_tier,
        matchedDirections: parseDirections(lead.matched_directions),
        repName: rep?.name ?? "Leon", repWechatId: rep?.wechat ?? "",
      });
      return { ok: true, lead: lead.author_email, intro: draft.introOutput.slice(0, 100), error: null };
    } catch (e) {
      return { ok: false, lead: lead.author_email, intro: "", error: (e as Error).message };
    }
  }));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nAll ${leads.length} leads rendered in parallel in ${dt}s\n`);
  for (const r of results) {
    if (r.ok) console.log(`  ✅ ${r.lead.padEnd(45)} "${r.intro}..."`);
    else console.log(`  ❌ ${r.lead.padEnd(45)} ERROR: ${r.error}`);
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount}/${results.length} passed`);
  if (okCount < results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
