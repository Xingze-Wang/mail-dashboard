import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  const { data, error } = await supabase
    .from("sales_reps")
    .select("*")
    .order("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ reps: data });
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
      .select()
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
