import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  const { count, error } = await supabase
    .from("inbound_emails")
    .select("*", { count: "exact", head: true })
    .eq("is_read", false);

  if (error) {
    return NextResponse.json({ count: 0, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ count: count ?? 0 });
}
