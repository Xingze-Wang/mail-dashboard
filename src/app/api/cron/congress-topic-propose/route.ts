// /api/cron/congress-topic-propose — Thursday mid-week.
//
// LLM looks at the past 7 days of:
//   - admin_inbox idea/observation entries (what's been on admin's mind)
//   - insights_snapshots realignment_reason fields (what's drifted)
//   - rep_questions clusters (what reps are asking repeatedly)
//   - rep_edit_clustering output (what's getting drift-mined)
// and proposes 1-3 debate topics for next Monday's tactical congress.
//
// Each proposal gets pushed to admin as an admin_inbox card (kind=idea)
// with Yes/No buttons. Yes → status='approved' in congress_debate_proposals;
// next Monday's congress runner picks it up and converts to a real
// tactical_proposals row.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";

export const preferredRegion = ["hkg1"];
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4.6";

function nextMonday(today: Date): string {
  const d = new Date(today);
  const day = d.getUTCDay();             // 0=Sun, 1=Mon, ...
  const daysToMon = day === 0 ? 1 : (day <= 1 ? 8 - day : 8 - day);
  d.setUTCDate(d.getUTCDate() + daysToMon);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const target = nextMonday(new Date());
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Don't re-propose if there are still pending rows for this target Monday
  const { count: pendingCount } = await supabase
    .from("congress_debate_proposals")
    .select("*", { count: "exact", head: true })
    .eq("for_congress_on", target)
    .eq("status", "pending");
  if ((pendingCount ?? 0) >= 3) {
    return NextResponse.json({ ran: false, reason: "already 3+ pending for target Monday", target });
  }

  // Gather inputs
  const [inboxR, snapshotsR, clusterR] = await Promise.all([
    supabase.from("admin_inbox")
      .select("kind, headline, body, evidence, source_rep_id, created_at")
      .in("kind", ["idea", "observation"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.from("insights_snapshots")
      .select("dimension, scope, realignment_reason, created_at")
      .not("realignment_reason", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("rep_questions")
      .select("normalized, outcome, rep_id, asked_at")
      .eq("outcome", "escalated")
      .gte("asked_at", since)
      .order("asked_at", { ascending: false })
      .limit(30),
  ]);

  if ((inboxR.data?.length ?? 0) === 0 && (snapshotsR.data?.length ?? 0) === 0 && (clusterR.data?.length ?? 0) === 0) {
    return NextResponse.json({ ran: false, reason: "no signal — nothing to propose", target });
  }

  const userPayload = {
    today: new Date().toISOString().slice(0, 10),
    next_congress_on: target,
    admin_inbox_recent: inboxR.data ?? [],
    insights_realignments_recent: snapshotsR.data ?? [],
    rep_escalations_recent: clusterR.data ?? [],
  };

  const system = `你是 org 的策略顾问. 周一会开 Tactical Congress (跨 sales rep 的 debate 决策机制). 你的任务: 看过去 7 天的信号 (admin inbox 收到的 idea/observation, 数据切片 realignment, rep 升级的问题), 提 1-3 个**值得 congress 周一辩的话题**.

输出严格 JSON, 不要解释:
{
  "proposals": [
    {
      "topic_title": string (≤80 字, 一个**问题** 不是陈述, e.g. "我们要不要把 tier-3 schools 从默认 outbound 里移除"),
      "topic_body": string (2-4 句, 给 congress 一个 frame: 当前情况, 关键矛盾, 决定的影响),
      "evidence_refs": [string] (引用具体 inbox headline / realignment reason / escalation 关键字)
    }
  ]
}

写好 topic 的标准:
- 是个**有真实分歧的问题** (不要 "我们应该努力工作")
- 数据驱动: 引用具体数字 / 趋势, 不要拍脑袋
- 跨 rep / 跨 segment: 涉及组织级决策 (per-rep 行为不该上 congress)
- 1-3 个, 不要凑数. 真的没什么值得辩就只提 1 个或 0 个 (返回 {proposals: []}).

不要写废话题目:
- ❌ "我们应该如何提高转化率" (太宽)
- ❌ "上周表现复盘" (没有具体决定要做)
- ✅ "Tier-1 投递质量 3 周持续下滑 — 我们要不要换 outbound 模板基线"
- ✅ ".gov 投递这个月被 7 次问 — 我们要不要发或者明确不发"`;

  let parsed: { proposals: Array<{ topic_title: string; topic_body: string; evidence_refs?: string[] }> } | null = null;
  try {
    const r = await llmChat({
      model: MODEL,
      system,
      user: JSON.stringify(userPayload),
      json: true,
      max_tokens: 1500,
      temperature: 0.4,
      timeoutMs: 60_000,
    });
    let cleaned = r.text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("[congress-topic-propose] LLM failed:", err);
    return NextResponse.json({ ran: false, error: String(err).slice(0, 200) }, { status: 500 });
  }

  if (!parsed?.proposals?.length) {
    return NextResponse.json({ ran: true, proposed: 0, reason: "LLM returned no proposals (probably no signal)", target });
  }

  const inserted: Array<{ id: string; title: string }> = [];
  for (const p of parsed.proposals.slice(0, 3)) {
    const title = String(p.topic_title ?? "").slice(0, 200);
    const body = String(p.topic_body ?? "").slice(0, 1500);
    const refs = Array.isArray(p.evidence_refs) ? p.evidence_refs.map(String).slice(0, 8) : [];
    if (!title || !body) continue;

    const { data: row, error: insErr } = await supabase
      .from("congress_debate_proposals")
      .insert({
        for_congress_on: target,
        topic_title: title,
        topic_body: body,
        evidence: { evidence_refs: refs, generated_at: new Date().toISOString() },
        decision_model: MODEL,
      })
      .select("id")
      .single();
    if (insErr || !row) { console.error("insert failed:", insErr?.message); continue; }

    // Push admin_inbox idea card with Yes/No (Yes → approved → next Monday picks up)
    try {
      const enc = new TextEncoder();
      const key = `congress_topic|${row.id}`;
      const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
      const dedupHash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

      const headline = `🏛 Congress 话题建议: ${title}`.slice(0, 200);
      const cardBody = [
        `**议题:** ${title}`,
        "",
        body,
        "",
        refs.length > 0 ? `**证据:** ${refs.join(" · ")}` : "",
        "",
        `_周一 ${target} Congress 上讨论. Yes 通过, 周一会自动作为 tactical_proposal 进入 debate._`,
      ].filter(Boolean).join("\n");

      const { data: inbox } = await supabase
        .from("admin_inbox")
        .insert({
          kind: "idea",
          headline,
          body: cardBody,
          source_rep_id: null,
          evidence: {
            source: "congress",
            congress_debate_id: row.id,
            for_congress_on: target,
            evidence_refs: refs,
          },
          dedup_hash: dedupHash,
        })
        .select("id")
        .single();
      if (inbox) {
        await supabase.from("congress_debate_proposals").update({ inbox_id: inbox.id }).eq("id", row.id);
        const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
        await sendAdminInboxCard({
          inbox_id: inbox.id,
          kind: "idea",
          headline,
          body: cardBody,
          source_rep_id: null,
          evidence: { source: "congress", congress_debate_id: row.id },
        });
      }
    } catch (err) {
      console.warn("[congress-topic-propose] card push failed:", err);
    }

    inserted.push({ id: row.id, title });
  }

  return NextResponse.json({
    ran: true,
    target,
    duration_ms: Date.now() - t0,
    proposed: inserted.length,
    proposals: inserted,
  });
}
