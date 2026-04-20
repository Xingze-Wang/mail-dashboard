import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  const { data, error } = await supabase
    .from("sales_reps")
    .select("id,name,sender_email,wechat_id")
    .eq("active", true)
    .order("id");
  if (error) return NextResponse.json({ error: error.message, reps: [] }, { status: 500 });
  return NextResponse.json({ reps: data ?? [] });
}
