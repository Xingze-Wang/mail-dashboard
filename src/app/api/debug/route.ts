import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";

export async function GET() {
  const results: Record<string, unknown> = {};

  // 1. Test Resend API
  try {
    const r = await resend.emails.list({ limit: 2 });
    results.resend = {
      ok: !r.error,
      error: r.error?.message,
      count: r.data?.data?.length,
      sample: r.data?.data?.[0] ? {
        id: r.data.data[0].id,
        from: r.data.data[0].from,
        subject: r.data.data[0].subject,
        last_event: r.data.data[0].last_event,
      } : null,
    };
  } catch (e: unknown) {
    results.resend = { ok: false, error: String(e) };
  }

  // 2. Test Supabase read
  try {
    const { data, error, count } = await supabase
      .from("emails")
      .select("*", { count: "exact" })
      .limit(2);
    results.supabase_read = {
      ok: !error,
      error: error?.message,
      count,
      rows: data?.length,
      sample: data?.[0],
    };
  } catch (e: unknown) {
    results.supabase_read = { ok: false, error: String(e) };
  }

  // 3. Test Supabase insert
  try {
    const testId = `test_${Date.now()}`;
    const { data, error } = await supabase
      .from("emails")
      .insert({
        from: "test@test.com",
        to: "test@test.com",
        subject: "DEBUG TEST - delete me",
        html: "",
        resend_id: testId,
        status: "sent",
        thread_id: `thread_test_${Date.now()}`,
      })
      .select()
      .single();
    results.supabase_insert = {
      ok: !error,
      error: error?.message,
      hint: error?.hint,
      details: error?.details,
      inserted: data,
    };

    // Clean up
    if (data?.id) {
      await supabase.from("emails").delete().eq("id", data.id);
    }
  } catch (e: unknown) {
    results.supabase_insert = { ok: false, error: String(e) };
  }

  return NextResponse.json(results, { status: 200 });
}
