import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";

export const maxDuration = 300;

/**
 * Programmatic entrypoint to the drift miner — used by the cron route so
 * the daily job can populate prompt_drift_patterns without anyone clicking
 * "Run miner" in the UI. The HTTP POST below is a thin wrapper that just
 * passes through admin-supplied options and returns the same shape.
 */
export async function runDriftMine(
  maxLeads = 120,
  lookbackDays = 30,
  repId: number | null = null,
): Promise<{
  mined: number;
  pairsConsidered?: number;
  patternsFound?: number;
  inserted?: Array<Record<string, unknown>>;
  reason?: string;
  error?: string;
}> {
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  let q = supabase
    .from("pipeline_leads")
    .select("id, draft_original_html, draft_html, edit_reasons, edit_note, draft_model, assigned_rep_id")
    .eq("status", "sent")
    .gte("sent_at", cutoff)
    .not("draft_original_html", "is", null)
    .not("draft_edit_distance", "eq", 0)
    .limit(maxLeads);
  if (repId !== null) q = q.eq("assigned_rep_id", repId);
  const { data: rows, error } = await q;
  if (error) return { mined: 0, error: error.message };

  const pairs = (rows ?? []) as PairRow[];
  // Floor of 2: at small team volume a 2-pair pattern with matching
  // edit_reasons IS real signal; we mark these with lower confidence.
  // Below 2 there's literally nothing to compare.
  if (pairs.length < 2) {
    return {
      mined: 0,
      reason: `only ${pairs.length} edited leads in last ${lookbackDays} days — need ≥ 2 for pattern detection`,
    };
  }

  const stripped = pairs.map((r) => ({
    id: r.id.slice(0, 8),
    ai: stripHtml(r.draft_original_html ?? "").slice(0, 600),
    sales: stripHtml(r.draft_html ?? "").slice(0, 600),
    reasons: r.edit_reasons ?? [],
  }));
  const sample = JSON.stringify(stripped, null, 2).slice(0, 8000);

  let raw = "";
  try {
    const r = await llmChat({
      model: "claude-opus-4.7",
      system: MINER_SYSTEM,
      user: `共 ${pairs.length} 对 (展示前 ${stripped.length} 对):\n\n${sample}\n\n找 pattern。`,
      temperature: 0.1, max_tokens: 3000, json: true, timeoutMs: 90_000,
    });
    raw = r.text;
  } catch (e) {
    try {
      const r = await llmChat({
        model: "gemini-3-pro",
        system: MINER_SYSTEM,
        user: `共 ${pairs.length} 对:\n\n${sample}`,
        temperature: 0.1, max_tokens: 3000, json: true, timeoutMs: 90_000,
      });
      raw = r.text;
    } catch (e2) {
      return {
        mined: 0,
        error: `Both Opus and Gemini failed: ${e instanceof Error ? e.message : e} | ${e2 instanceof Error ? e2.message : e2}`,
      };
    }
  }

  let patterns: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(stripFences(raw));
    if (Array.isArray(parsed)) patterns = parsed;
    else if (Array.isArray((parsed as Record<string, unknown>).patterns)) patterns = (parsed as { patterns: Array<Record<string, unknown>> }).patterns;
  } catch (e) {
    return { mined: 0, error: `parse failed: ${e}` };
  }

  const validPatterns = patterns.filter(
    (p) => typeof p.ai_phrase === "string" && typeof p.category === "string" && Number(p.occurrence_count) >= 2,
  );

  const inserted: Array<Record<string, unknown>> = [];
  for (const p of validPatterns) {
    const { data: existing } = await supabase
      .from("prompt_drift_patterns")
      .select("id")
      .eq("status", "pending")
      .ilike("ai_phrase", String(p.ai_phrase))
      .limit(1);
    if (existing && existing.length > 0) continue;

    const { data: ins } = await supabase
      .from("prompt_drift_patterns")
      .insert({
        rep_id: repId,
        category: p.category,
        ai_phrase: p.ai_phrase,
        sales_phrase: p.sales_phrase ?? null,
        occurrence_count: Number(p.occurrence_count) || 1,
        example_lead_ids: Array.isArray(p.example_lead_ids) ? p.example_lead_ids : [],
        prompt_patch: p.prompt_patch ?? null,
        status: "pending",
      })
      .select()
      .single();
    if (ins) inserted.push(ins);
  }

  return {
    mined: inserted.length,
    pairsConsidered: pairs.length,
    patternsFound: validPatterns.length,
    inserted,
  };
}

const MINER_SYSTEM = `你是一个 prompt-engineering 专家。下面是 sales 改 AI 写的销售邮件的 (原版, 改后) pairs。
任务：找出 sales 反复修改的模式（出现 ≥2 次的）。少量样本可以接受 — pattern 不必很普适，能解释 ≥2 个例子即可。

返回 JSON 数组，每个 pattern 一项：
{
  "category": "ai_misunderstood" | "format" | "too_verbose" | "too_robotic" | "individual_taste",
  "ai_phrase": "AI 反复用的措辞 (短词 ≤30 字)",
  "sales_phrase": "Sales 改成的措辞 (≤30 字, 删除则空字符串)",
  "occurrence_count": 频次,
  "example_lead_ids": ["uuid", ...],   // 出现这个 pattern 的 lead id (≤5 个)
  "prompt_patch": "建议在 INTRO_PROMPT_TEMPLATE 加一行什么禁用规则 (中文, ≤80 字)"
}

只返回 JSON 数组，不要其他文字。如果没找到 pattern，返回 []。`;

interface PairRow {
  id: string;
  draft_original_html: string | null;
  draft_html: string | null;
  edit_reasons: string[] | null;
  edit_note: string | null;
  draft_model: string | null;
  assigned_rep_id: number | null;
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const days = Number(body.days ?? 30);
  const repId: number | null = body.repId ?? null;
  const maxLeads = Number(body.maxLeads ?? 120);

  const result = await runDriftMine(maxLeads, days, repId);
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json(result);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    const i = t.indexOf("\n");
    t = t.slice(i + 1);
    if (t.endsWith("```")) t = t.slice(0, -3);
  }
  return t.trim();
}
