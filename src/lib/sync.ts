import { resend } from "@/lib/resend";
import { supabase } from "@/lib/db";

const STATUS_MAP: Record<string, string> = {
  sent: "sent",
  delivered: "delivered",
  opened: "opened",
  clicked: "clicked",
  bounced: "bounced",
  complained: "complained",
  delivery_delayed: "sent",
};

/**
 * Syncs all emails from Resend into Supabase.
 * - Inserts new emails (by resend_id)
 * - Updates status of existing emails if Resend has a newer status
 */
export async function syncFromResend(): Promise<{ imported: number; updated: number; total: number }> {
  let imported = 0;
  let updated = 0;
  let total = 0;
  let cursor: string | undefined;
  const batchSize = 100;

  while (true) {
    const params: { limit: number; cursor?: string } = { limit: batchSize };
    if (cursor) params.cursor = cursor;

    const result = await resend.emails.list(params);

    if (result.error || !result.data) {
      break;
    }

    const emails = result.data.data;
    if (!emails || emails.length === 0) break;

    total += emails.length;

    for (const email of emails) {
      const status = STATUS_MAP[email.last_event] || "sent";

      // Check if already exists
      const { data: existing } = await supabase
        .from("emails")
        .select("id, status")
        .eq("resend_id", email.id)
        .single();

      if (existing) {
        // Update status if it changed
        if (existing.status !== status) {
          await supabase
            .from("emails")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          updated++;
        }
        continue;
      }

      // Insert new email
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

    if (emails.length < batchSize) break;
    cursor = emails[emails.length - 1].id;
  }

  return { imported, updated, total };
}
