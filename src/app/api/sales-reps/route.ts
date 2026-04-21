import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

// Explicit allowlist — never SELECT * here, password_hash and login_email
// must NOT leak to clients (admin UI doesn't need them; nothing else does).
const SAFE_REP_COLUMNS =
  "id, name, sender_name, sender_email, wechat_id, active, role, username, created_at";

export async function GET() {
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
  const body = await req.json();
  const { id, name, sender_email, sender_name, wechat_id, active } = body;

  if (!name || !sender_email || !sender_name || !wechat_id) {
    return NextResponse.json(
      { error: "name, sender_email, sender_name, wechat_id are required" },
      { status: 400 },
    );
  }

  if (id) {
    // Update existing
    const { data, error } = await supabase
      .from("sales_reps")
      .update({ name, sender_email, sender_name, wechat_id, active: active ?? true })
      .eq("id", id)
      .select(SAFE_REP_COLUMNS)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ rep: data });
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
