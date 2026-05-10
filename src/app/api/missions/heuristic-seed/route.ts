import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/missions/heuristic-seed
 *
 * Seeds today's missions based on each rep's queue depth. Used as a
 * "v0 something to do" generator until weekly congress takes over
 * the per-rep mission generation.
 *
 * Logic per rep:
 *   - Count `ready` leads in their queue.
 *   - send target = clamp(ready_count, 5, 12). i.e. always at least 5
 *     to keep momentum, never more than 12 to avoid burnout.
 *   - Count unread inbounds tied to this rep's leads (proxy via
 *     emails.actor_rep_id since CLAUDE.md says actor=who sent).
 *   - reply target = unread_inbounds (capped at 5).
 *   - mark_wechat target = 0 (admin/manual; not generated heuristically).
 *
 * Idempotency: if today already has heuristic missions for this rep,
 * skip them. Won't ever overwrite congress-generated missions.
 *
 * Auth: admin only (this is a one-shot seed; not for sales).
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface SeedResult {
  rep_id: number;
  rep_name: string;
  send_target: number;
  reply_target: number;
  skipped_reason?: string;
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const today = todayIso();

  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, sender_name, name, role, active")
    .eq("active", true)
    .neq("role", "service");
  if (!reps || reps.length === 0) {
    return NextResponse.json({ error: "No active reps" }, { status: 404 });
  }

  const results: SeedResult[] = [];

  for (const r of reps) {
    const repId = r.id as number;
    const repName = ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${repId}`);

    // Skip if today already has any missions for this rep.
    const { data: existing } = await supabase
      .from("missions")
      .select("id")
      .eq("rep_id", repId)
      .eq("due_date", today)
      .limit(1);
    if (existing && existing.length > 0) {
      results.push({ rep_id: repId, rep_name: repName, send_target: 0, reply_target: 0, skipped_reason: "already has missions today" });
      continue;
    }

    // Send target — clamp the queue depth into a sane range.
    const { count: readyCount } = await supabase
      .from("pipeline_leads")
      .select("id", { count: "exact", head: true })
      .eq("assigned_rep_id", repId)
      .eq("status", "ready");
    const sendTarget = Math.max(5, Math.min(12, readyCount ?? 5));

    // Reply target — count inbound replies that haven't been
    // acknowledged. Cheap proxy: inbound_emails rows where the source
    // email's actor was this rep, in the last 7 days.
    const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: myEmails } = await supabase
      .from("emails")
      .select("id")
      .eq("actor_rep_id", repId)
      .gte("created_at", since7)
      .limit(500);
    const myEmailIds = (myEmails ?? []).map((e) => e.id as string);
    let replyTarget = 0;
    if (myEmailIds.length > 0) {
      const { count: inboundCount } = await supabase
        .from("inbound_emails")
        .select("id", { count: "exact", head: true })
        .in("source_email_id", myEmailIds);
      replyTarget = Math.min(5, inboundCount ?? 0);
    }

    // Insert missions.
    const rows: Array<Record<string, unknown>> = [
      {
        rep_id: repId,
        due_date: today,
        kind: "send",
        target: sendTarget,
        description: `今天的目标: 发 ${sendTarget} 封 (基于你 ready 队列里的数量算出来的, 5-12 区间).`,
        generated_by: "heuristic",
        status: "active",
      },
    ];
    if (replyTarget > 0) {
      rows.push({
        rep_id: repId,
        due_date: today,
        kind: "reply",
        target: replyTarget,
        description: `回复 ${replyTarget} 个 inbound (你过去 7 天发的邮件收到的回信).`,
        generated_by: "heuristic",
        status: "active",
      });
    }

    const { error } = await supabase.from("missions").insert(rows);
    if (error) {
      results.push({ rep_id: repId, rep_name: repName, send_target: 0, reply_target: 0, skipped_reason: `insert failed: ${error.message}` });
      continue;
    }

    results.push({ rep_id: repId, rep_name: repName, send_target: sendTarget, reply_target: replyTarget });
  }

  return NextResponse.json({ today, results });
}
