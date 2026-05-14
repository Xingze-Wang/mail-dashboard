import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/admin/recent-card-activity?minutes=15
 *
 * Admin diagnostic: did recent Lark card clicks reach prod? Returns:
 *  - admin_inbox smoke rows (proves quota_action handler ran)
 *  - lark_messages mirrored in the window (any card_action sideband)
 *  - email_templates touched in the window (proves template_action ran)
 *
 * Read-only. Used to verify "I clicked the smoke card — did anything
 * happen?" without paging through Vercel function logs.
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const minutes = Math.min(
    Math.max(parseInt(new URL(req.url).searchParams.get("minutes") ?? "15", 10), 1),
    240,
  );
  const since = new Date(Date.now() - minutes * 60_000).toISOString();

  const [adminInbox, larkMsgs, tmplTouched, webhookTrace] = await Promise.all([
    supabase
      .from("admin_inbox")
      .select("id, headline, status, acted_at, dedup_hash, created_at, evidence")
      .or(`dedup_hash.like.smoke-%,created_at.gte.${since}`)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("lark_messages")
      .select("id, role, text, metadata, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("email_templates")
      .select("id, name, status, active, updated_at, rejected_at")
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("lark_webhook_trace")
      .select("id, received_at, event_type, is_card_action, operator_open_id, action_value, processed, error")
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(30),
  ]);

  return NextResponse.json({
    since,
    admin_inbox: adminInbox.data ?? [],
    admin_inbox_err: adminInbox.error?.message,
    lark_messages: (larkMsgs.data ?? []).map((m) => ({
      ...m,
      text: typeof m.text === "string" ? m.text.slice(0, 200) : m.text,
    })),
    lark_messages_err: larkMsgs.error?.message,
    templates_touched: tmplTouched.data ?? [],
    templates_touched_err: tmplTouched.error?.message,
    webhook_trace: webhookTrace.data ?? [],
    webhook_trace_err: webhookTrace.error?.message,
  });
}
