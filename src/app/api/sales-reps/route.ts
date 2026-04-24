import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/auth-helpers";

// Explicit allowlist — never SELECT * here, password_hash and login_email
// must NOT leak to clients (admin UI doesn't need them; nothing else does).
const SAFE_REP_COLUMNS =
  "id, name, sender_name, sender_email, wechat_id, active, role, username, created_at";

export async function GET(req: NextRequest) {
  // Any authenticated user can list reps (sales UI needs rep names for
  // the assigned-to column). Only the allowlisted columns are returned,
  // no secrets.
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return getReps();
}

async function getReps(): Promise<NextResponse> {
  try {
    const { data, error } = await supabase
      .from("sales_reps")
      .select(SAFE_REP_COLUMNS)
      .order("id");

    if (error) {
      // Table may not exist yet
      if (error.code === "PGRST205") return NextResponse.json({ reps: [] });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ reps: data });
  } catch {
    return NextResponse.json({ reps: [] });
  }
}

export async function POST(req: NextRequest) {
  // ADMIN-only — creating or editing any rep (including self) must
  // require admin. Previously unauth: a sales rep could POST with
  // their own id and e.g. rename themselves, or a stranger could
  // create a new "admin" rep row (role isn't set here but the row
  // exists, enabling later escalation via direct DB access).
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json();
  const { id, name, sender_email, sender_name, wechat_id, active } = body;

  if (!name || !sender_email || !sender_name || !wechat_id) {
    return NextResponse.json(
      { error: "name, sender_email, sender_name, wechat_id are required" },
      { status: 400 },
    );
  }

  if (id) {
    // Before writing, fetch the existing row so we can tell whether
    // identity fields changed. sender_name / wechat_id are baked into
    // draft_html, so when they change we must re-queue this rep's
    // unsent leads so the draft-queue worker regenerates drafts with
    // the new identity. Without this, existing "ready" leads send
    // with the OLD wechat id long after the rep was renamed.
    const { data: before } = await supabase
      .from("sales_reps")
      .select("sender_name, wechat_id, sender_email")
      .eq("id", id)
      .maybeSingle();

    const { data, error } = await supabase
      .from("sales_reps")
      .update({ name, sender_email, sender_name, wechat_id, active: active ?? true })
      .eq("id", id)
      .select(SAFE_REP_COLUMNS)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let requeued = 0;
    const identityChanged = before && (
      before.sender_name !== sender_name ||
      before.wechat_id   !== wechat_id
    );
    if (identityChanged) {
      // Only touch leads that haven't gone out yet — sent/replied
      // rows keep their historical draft so the metrics stay honest.
      const { data: requeuedRows } = await supabase
        .from("pipeline_leads")
        .update({
          status: "queued",
          draft_subject: null,
          draft_html: null,
          draft_original_subject: null,
          draft_original_html: null,
          draft_edit_distance: null,
        })
        .eq("assigned_rep_id", id)
        .in("status", ["ready", "drafting"])
        .select("id");
      requeued = requeuedRows?.length ?? 0;
    }

    return NextResponse.json({ rep: data, requeued });
  }

  // Create new
  const { data, error } = await supabase
    .from("sales_reps")
    .insert({ name, sender_email, sender_name, wechat_id, active: active ?? true })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rep: data });
}
