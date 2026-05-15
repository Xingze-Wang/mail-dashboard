// Daily digest of Leon's DB writes — runs once via the main /api/cron
// fan-out. Pulls db_write_log entries from the past 24h, groups by
// source (auto / approved_proposal / admin_self) and table, and DMs
// admin a one-screen summary.
//
// Why this exists: user asked for a "daily digest" rather than
// per-write DMs. The dispatch model is silent-on-success — so without
// this cron, admin has no visibility into auto-writes Leon did.
//
// Sends nothing on empty days (no spam).

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const preferredRegion = ["hkg1"];
export const maxDuration = 30;

const ADMIN_REP_ID = 5;

function authorize(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET ?? "";
  return !!secret && auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data: rows, error } = await supabase
    .from("db_write_log")
    .select("source, table_name, ok, rows_affected, error, ran_at")
    .gte("ran_at", since)
    .order("ran_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ran: false, reason: "no writes in last 24h" });
  }

  // Group by source + table
  const buckets = new Map<string, { ok: number; failed: number; rows_total: number; samples: string[] }>();
  let failedCount = 0;
  for (const r of rows) {
    const key = `${r.source}|${r.table_name ?? "?"}`;
    const b = buckets.get(key) ?? { ok: 0, failed: 0, rows_total: 0, samples: [] };
    if (r.ok) {
      b.ok++;
      b.rows_total += Number(r.rows_affected ?? 0);
    } else {
      b.failed++;
      failedCount++;
      if (b.samples.length < 2 && r.error) b.samples.push(r.error.slice(0, 120));
    }
    buckets.set(key, b);
  }

  // Build human-readable summary
  const lines: string[] = [
    `📊 **过去 24h DB writes 总结** (共 ${rows.length} 次, 失败 ${failedCount})`,
    "",
  ];
  const sortedKeys = [...buckets.keys()].sort();
  for (const k of sortedKeys) {
    const [source, table] = k.split("|");
    const b = buckets.get(k)!;
    const sourceLabel = source === "auto" ? "🤖 auto"
      : source === "approved_proposal" ? "✅ 你批准的"
      : source === "admin_self" ? "✍️ 你自己" : source;
    lines.push(`${sourceLabel} → \`${table}\`: ${b.ok} 成功 (${b.rows_total} 行)${b.failed > 0 ? `, ${b.failed} 失败` : ""}`);
    for (const s of b.samples) lines.push(`  ⚠️ ${s}`);
  }

  // DM admin
  const { data: admin } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", ADMIN_REP_ID)
    .maybeSingle();
  if (admin?.lark_open_id) {
    try {
      const { getTenantAccessToken, pickBase } = await import("@/lib/lark");
      const token = await getTenantAccessToken();
      if (token) {
        await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            receive_id: admin.lark_open_id,
            msg_type: "text",
            content: JSON.stringify({ text: lines.join("\n") }),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch (err) {
      console.warn("[db-write-digest] DM failed:", err);
    }
  }

  return NextResponse.json({
    ran: true,
    total_writes: rows.length,
    failed: failedCount,
    bucket_count: buckets.size,
    summary: lines.join("\n"),
  });
}
