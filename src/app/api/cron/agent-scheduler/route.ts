// src/app/api/cron/agent-scheduler/route.ts
//
// Fires Leon's schedule_action rows when their next_fire_at hits.
// Runs DAILY at 09:00 UTC (Hobby plan rejects sub-daily — see commit
// a2906f9; v1 was */5 but Vercel refused the deploy). Only acts on:
//   status='active' AND admin_approved=true AND next_fire_at<=now()
//
// Practical consequence: minute-level cron_expr values still work
// (e.g. "0 17 * * 5") but only get *evaluated* once per day. So a
// row due Friday 17:00 UTC actually fires Saturday 09:00 UTC.
// Leon's schedule_action docstring tells the agent to set
// expectations accordingly ("I'll send it Friday morning your time"
// not "I'll send it exactly at 5pm").
//
// Pending (admin_approved=false) rows are visible in admin_inbox as
// Yes/No cards — they stay dormant here. After admin Yes flips
// admin_approved to true (via admin-inbox-card.ts handler), this cron
// picks them up on its next pass.
//
// After each successful fire:
//   - bumps fire_count
//   - sets last_fire_at = now
//   - recomputes next_fire_at from cron_expr (basic 5-field parser)
//
// On error:
//   - sets status='errored' + last_error (so it won't keep retrying
//     forever; admin sees the error and decides whether to resume).

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = ["hkg1"];

interface Row {
  id: string;
  created_by: number;
  target_rep_id: number | null;
  kind: "dm_user" | "call_tool" | "call_workflow";
  cron_expr: string;
  payload: Record<string, unknown>;
  next_fire_at: string;
  fire_count: number;
}

// Compute the next fire time from a 5-field cron. v1 supports the common
// patterns Leon will emit:
//   - daily at H:M:      "M H * * *"
//   - weekdays at H:M:   "M H * * 1-5"
//   - specific dow:      "M H * * 5"   (Friday)
//   - hourly at minute:  "M * * * *"
// For anything else, falls back to "1 day from now" and logs a warning.
function nextFireUTC(cronExpr: string, after = new Date()): Date {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return new Date(after.getTime() + 24 * 60 * 60 * 1000);
  }
  const [minStr, hrStr, , , dowStr] = parts;
  const min = parseInt(minStr, 10);
  const hr = parseInt(hrStr, 10);
  // Hourly case: hour is "*", min is a number
  if (hrStr === "*" && !isNaN(min)) {
    const d = new Date(after);
    d.setUTCMinutes(min, 0, 0);
    if (d <= after) d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }
  if (isNaN(min) || isNaN(hr)) {
    // Unparseable; defer 1 day
    return new Date(after.getTime() + 24 * 60 * 60 * 1000);
  }
  // dow can be: * | N | N-M | N,M
  const allowedDows: number[] = (() => {
    if (dowStr === "*") return [0, 1, 2, 3, 4, 5, 6];
    if (/^\d$/.test(dowStr)) return [parseInt(dowStr, 10)];
    const m = dowStr.match(/^(\d)-(\d)$/);
    if (m) {
      const lo = parseInt(m[1], 10);
      const hi = parseInt(m[2], 10);
      const out: number[] = [];
      for (let i = lo; i <= hi; i++) out.push(i);
      return out;
    }
    if (dowStr.includes(",")) return dowStr.split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    return [0, 1, 2, 3, 4, 5, 6];
  })();
  // Walk forward day by day, max 8 days to handle weekly fires
  for (let i = 0; i < 8; i++) {
    const d = new Date(after);
    d.setUTCDate(d.getUTCDate() + i);
    d.setUTCHours(hr, min, 0, 0);
    if (d <= after) continue;
    if (allowedDows.includes(d.getUTCDay())) return d;
  }
  return new Date(after.getTime() + 24 * 60 * 60 * 1000);
}

async function fireRow(row: Row): Promise<{ ok: boolean; error?: string }> {
  try {
    if (row.kind === "dm_user") {
      if (row.target_rep_id === null) return { ok: false, error: "dm_user missing target_rep_id" };
      const message = String((row.payload as { message?: string }).message ?? "");
      if (!message) return { ok: false, error: "dm_user payload.message empty" };
      // Resolve target rep → open_id
      const { data: rep, error: repErr } = await supabase
        .from("sales_reps")
        .select("lark_open_id")
        .eq("id", row.target_rep_id)
        .single();
      if (repErr || !rep?.lark_open_id) {
        return { ok: false, error: `target rep ${row.target_rep_id} has no lark_open_id` };
      }
      const { sendMessage } = await import("@/lib/lark");
      const r = await sendMessage({
        receive_id: rep.lark_open_id as string,
        receive_id_type: "open_id",
        text: `⏰ ${message}`,
      });
      if (!r.ok) return { ok: false, error: `lark send: ${r.error ?? "unknown"}` };
      return { ok: true };
    }
    if (row.kind === "call_tool") {
      // Reserved for v2 — would need to construct a fake session +
      // dispatch runReadTool here, then write result into admin_inbox.
      // Skipping in v1; row marked errored so admin can inspect.
      return { ok: false, error: "call_tool kind not implemented in v1; tell admin to extend agent-scheduler" };
    }
    if (row.kind === "call_workflow") {
      // v1 ships zero workflows. To add: hardcode here, e.g.
      //   if (payload.workflow_name === "scan_stale_wechat_dm_owners") { ... }
      return { ok: false, error: `unknown workflow_name '${(row.payload as { workflow_name?: string }).workflow_name}'; no workflows registered in v1` };
    }
    return { ok: false, error: `unknown kind '${row.kind}'` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const { data: due, error: queryErr } = await supabase
    .from("agent_scheduled_actions")
    .select("id,created_by,target_rep_id,kind,cron_expr,payload,next_fire_at,fire_count")
    .eq("status", "active")
    .eq("admin_approved", true)
    .lte("next_fire_at", now.toISOString())
    .limit(50);
  if (queryErr) {
    return NextResponse.json({ ok: false, error: queryErr.message }, { status: 500 });
  }
  const rows = (due ?? []) as Row[];
  const results: Array<{ id: string; fired: boolean; error?: string }> = [];

  for (const row of rows) {
    const r = await fireRow(row);
    if (r.ok) {
      const next = nextFireUTC(row.cron_expr, now).toISOString();
      await supabase
        .from("agent_scheduled_actions")
        .update({
          fire_count: row.fire_count + 1,
          last_fire_at: now.toISOString(),
          next_fire_at: next,
          last_error: null,
          updated_at: now.toISOString(),
        })
        .eq("id", row.id);
      results.push({ id: row.id, fired: true });
    } else {
      // Mark errored so it won't keep failing every 5 min. Admin can
      // inspect last_error and reset status='active' to retry.
      await supabase
        .from("agent_scheduled_actions")
        .update({
          status: "errored",
          last_error: r.error ?? "unknown",
          updated_at: now.toISOString(),
        })
        .eq("id", row.id);
      results.push({ id: row.id, fired: false, error: r.error });
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    fired: results.filter((r) => r.fired).length,
    errored: results.filter((r) => !r.fired).length,
    details: results,
  });
}
