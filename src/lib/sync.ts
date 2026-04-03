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
 * Incremental sync: fetches recent emails from Resend and stops
 * as soon as it hits emails already in the DB with matching status.
 * First run imports everything; subsequent runs are fast.
 */
export async function syncFromResend(): Promise<{ imported: number; updated: number; total: number }> {
  let imported = 0;
  let updated = 0;
  let total = 0;
  let cursor: string | undefined;
  let consecutiveSkips = 0;
  const batchSize = 100;
  // Stop early after hitting this many already-synced emails in a row
  const SKIP_THRESHOLD = 50;

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

      const { data: existing } = await supabase
        .from("emails")
        .select("id, status")
        .eq("resend_id", email.id)
        .single();

      if (existing) {
        if (existing.status !== status) {
          await supabase
            .from("emails")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          updated++;
          consecutiveSkips = 0;
        } else {
          consecutiveSkips++;
        }
        continue;
      }

      // New email — insert it
      consecutiveSkips = 0;
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

    // If we've seen 50+ already-synced emails in a row, we're caught up
    if (consecutiveSkips >= SKIP_THRESHOLD) break;

    if (emails.length < batchSize) break;
    cursor = emails[emails.length - 1].id;
  }

  return { imported, updated, total };
}
