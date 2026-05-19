// src/app/api/cron/agent-dumbness-check/route.ts
//
// Weekly Mondays 00:00 UTC (~ Beijing 8am) — checks whether Leon's
// per-turn tool-call count is trending up. If it is (>1.5x prior 28d
// baseline), pushes an admin_inbox card warning of possible "openclaw
// dumb-ification". Silent otherwise.
//
// What it computes:
//   last7  = avg tool_call_log rows per distinct (session_id, turn_index)
//             over the past 7 days
//   prior  = same metric over the 28 days BEFORE last7
//   ratio  = last7 / prior
//
// Why per-(session,turn): a "turn" is one user message → one agent
// response. If Leon used to use 1.2 tools per response and now uses
// 3.5, that's the openclaw signal.
//
// Skips if either window has <50 turns (not enough data to be reliable).
// First ~5 weeks after instrumentation rollout will be silent.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = ["hkg1"];

const ALERT_RATIO = 1.5;          // last7 must be ≥1.5x prior 28d
const MIN_TURNS = 50;             // min sample in EACH window
const DAY_MS = 24 * 60 * 60 * 1000;

interface CallRow {
  session_id: string | null;
  turn_index: number | null;
  created_at: string;
  tool_name: string;
}

function avgToolsPerTurn(rows: CallRow[]): { turns: number; avg: number } {
  // Group by (session_id, turn_index); count tools per group.
  const turnCounts = new Map<string, number>();
  for (const r of rows) {
    if (!r.session_id || r.turn_index === null) continue;
    const key = `${r.session_id}|${r.turn_index}`;
    turnCounts.set(key, (turnCounts.get(key) ?? 0) + 1);
  }
  const turns = turnCounts.size;
  if (turns === 0) return { turns: 0, avg: 0 };
  let total = 0;
  for (const n of turnCounts.values()) total += n;
  return { turns, avg: total / turns };
}

async function fetchWindow(startISO: string, endISO: string): Promise<CallRow[]> {
  const rows: CallRow[] = [];
  let page = 0;
  const PAGE = 1000;
  while (page < 50) { // hard cap ~50K rows
    const { data, error } = await supabase
      .from("tool_call_log")
      .select("session_id,turn_index,created_at,tool_name")
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: true })
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw new Error(`tool_call_log fetch: ${error.message}`);
    const got = (data ?? []) as CallRow[];
    rows.push(...got);
    if (got.length < PAGE) break;
    page++;
  }
  return rows;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const last7Start = new Date(now.getTime() - 7 * DAY_MS);
  const priorStart = new Date(now.getTime() - 35 * DAY_MS);

  try {
    const last7 = await fetchWindow(last7Start.toISOString(), now.toISOString());
    const prior = await fetchWindow(priorStart.toISOString(), last7Start.toISOString());
    const l = avgToolsPerTurn(last7);
    const p = avgToolsPerTurn(prior);

    // Insufficient data — silent
    if (l.turns < MIN_TURNS || p.turns < MIN_TURNS) {
      return NextResponse.json({
        ok: true,
        action: "silent_insufficient_data",
        last7: l,
        prior_28d: p,
        threshold: { min_turns: MIN_TURNS, ratio: ALERT_RATIO },
      });
    }

    const ratio = p.avg === 0 ? Infinity : l.avg / p.avg;

    // Also compute "top growing tools" — which tool's call share grew most?
    // (Helps admin see which tool is causing the inflation.)
    const topGrowingTools = (() => {
      const lastByTool = new Map<string, number>();
      const priorByTool = new Map<string, number>();
      for (const r of last7) lastByTool.set(r.tool_name, (lastByTool.get(r.tool_name) ?? 0) + 1);
      for (const r of prior) priorByTool.set(r.tool_name, (priorByTool.get(r.tool_name) ?? 0) + 1);
      const lastTotal = last7.length;
      const priorTotal = prior.length;
      if (lastTotal === 0 || priorTotal === 0) return [];
      const all = new Set([...lastByTool.keys(), ...priorByTool.keys()]);
      const out: Array<{ tool: string; lastShare: number; priorShare: number; delta: number }> = [];
      for (const t of all) {
        const lastShare = (lastByTool.get(t) ?? 0) / lastTotal;
        const priorShare = (priorByTool.get(t) ?? 0) / priorTotal;
        const delta = lastShare - priorShare;
        if (Math.abs(delta) > 0.02) out.push({ tool: t, lastShare, priorShare, delta });
      }
      out.sort((a, b) => b.delta - a.delta);
      return out.slice(0, 5);
    })();

    if (ratio < ALERT_RATIO) {
      return NextResponse.json({
        ok: true,
        action: "silent_within_threshold",
        last7: l,
        prior_28d: p,
        ratio,
        threshold: { ratio: ALERT_RATIO },
        top_growing_tools: topGrowingTools,
      });
    }

    // Trip wire: ratio ≥ 1.5x. Push admin_inbox card.
    const headline = `🤖 Leon 笨化预警: 每 turn tool 数 ${p.avg.toFixed(2)} → ${l.avg.toFixed(2)} (${ratio.toFixed(1)}x)`;
    const body = [
      `**Tool-per-turn ratio**:`,
      `- 过去 7 天 avg: **${l.avg.toFixed(2)}** (over ${l.turns} turns)`,
      `- 之前 28 天 avg: **${p.avg.toFixed(2)}** (over ${p.turns} turns)`,
      `- 倍数: **${ratio.toFixed(1)}x** (threshold ${ALERT_RATIO}x)`,
      ``,
      topGrowingTools.length > 0
        ? `**调用份额上升最快的 tool**:\n` +
          topGrowingTools.map((t) =>
            `  - \`${t.tool}\`: ${(t.priorShare * 100).toFixed(1)}% → ${(t.lastShare * 100).toFixed(1)}% (+${(t.delta * 100).toFixed(1)}pp)`,
          ).join("\n")
        : "",
      ``,
      `**含义**: Leon 在每次回答时调更多 tool. 可能是:`,
      `  - 新加的 tool 比预期更频繁被调 (e.g. \`schedule_action\` 文档没写紧, agent 滥用)`,
      `  - 现有 tool 的 docstring "什么时候用" 不够严格`,
      `  - openclaw-style 笨化 (agent 沉迷 tool, 忘记主任务)`,
      ``,
      `**建议**: 看上升最快的 tool, 收紧它 docstring 的"什么时候用 (这是关键)" 段, 加 "不要" 例子.`,
    ].filter(Boolean).join("\n");

    const enc = new TextEncoder();
    // dedup by week — only fire once per Monday
    const weekKey = `dumbness|${now.toISOString().slice(0, 10)}`;
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(weekKey));
    const dedupHash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

    const { data: inbox, error: insErr } = await supabase
      .from("admin_inbox")
      .insert({
        kind: "observation",
        headline,
        body,
        source_rep_id: null, // system-generated
        evidence: {
          source: "agent_dumbness_check",
          ratio,
          last7_avg: l.avg,
          prior_28d_avg: p.avg,
          last7_turns: l.turns,
          prior_28d_turns: p.turns,
          top_growing_tools: topGrowingTools,
        },
        dedup_hash: dedupHash,
      })
      .select("id")
      .single();
    if (insErr) {
      return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
    }

    try {
      const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
      await sendAdminInboxCard({
        inbox_id: inbox!.id,
        kind: "observation",
        headline,
        body,
        source_rep_id: null,
        evidence: { source: "agent_dumbness_check" },
      });
    } catch (err) {
      console.warn("[dumbness-check] card push failed:", err);
    }

    return NextResponse.json({
      ok: true,
      action: "alerted",
      ratio,
      inbox_id: inbox!.id,
      last7: l,
      prior_28d: p,
      top_growing_tools: topGrowingTools,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
