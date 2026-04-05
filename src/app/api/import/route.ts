import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";

// Import historical emails from Resend API
export async function POST() {
  try {
    let imported = 0;
    let skipped = 0;
    let cursor: string | undefined;
    const batchSize = 100;

    // Paginate through all Resend emails
    while (true) {
      const params: { limit: number; cursor?: string } = { limit: batchSize };
      if (cursor) params.cursor = cursor;

      const result = await resend.emails.list(params);

      if (result.error || !result.data) {
        return NextResponse.json({
          error: result.error?.message || "Failed to fetch from Resend",
          imported,
          skipped,
        }, { status: 500 });
      }

      const emails = result.data.data;
      if (!emails || emails.length === 0) break;

      for (const email of emails) {
        // Check if already imported
        const { data: existing } = await supabase
          .from("emails")
          .select("id")
          .eq("resend_id", email.id)
          .single();

        if (existing) {
          skipped++;
          continue;
        }

        // Map Resend status
        let status = "sent";
        if (email.last_event === "delivered") status = "delivered";
        else if (email.last_event === "opened") status = "opened";
        else if (email.last_event === "clicked") status = "clicked";
        else if (email.last_event === "bounced") status = "bounced";
        else if (email.last_event === "complained") status = "complained";

        const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        await supabase.from("emails").insert({
          from: email.from,
          to: Array.isArray(email.to) ? email.to.join(", ") : (email.to || ""),
          subject: email.subject || "(no subject)",
          html: "",
          text: null,
          resend_id: email.id,
          status,
          created_at: email.created_at,
          updated_at: email.created_at,
          thread_id: threadId,
        });

        imported++;
      }

      // Check for next page
      if (emails.length < batchSize) break;
      cursor = emails[emails.length - 1].id;
    }

    return NextResponse.json({ imported, skipped });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
