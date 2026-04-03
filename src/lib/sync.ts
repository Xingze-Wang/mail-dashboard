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
 * Fast incremental sync from Resend.
 * - Fetches one page of recent emails (100)
 * - Batch-checks which ones exist in DB
 * - Inserts new ones, updates changed statuses
 * - Designed to complete well within Vercel's 10s function limit
 */
export async function syncFromResend(): Promise<{ imported: number; updated: number; total: number }> {
  let imported = 0;
  let updated = 0;

  // Fetch the most recent 100 emails from Resend
  const result = await resend.emails.list({ limit: 100 });

  if (result.error || !result.data) {
    return { imported: 0, updated: 0, total: 0 };
  }

  const emails = result.data.data;
  if (!emails || emails.length === 0) {
    return { imported: 0, updated: 0, total: 0 };
  }

  // Batch lookup: get all existing emails by resend_id in one query
  const resendIds = emails.map((e) => e.id);
  const { data: existingRows } = await supabase
    .from("emails")
    .select("id, resend_id, status")
    .in("resend_id", resendIds);

  const existingMap = new Map(
    (existingRows || []).map((row) => [row.resend_id, row])
  );

  // Separate into inserts and updates
  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: { id: string; status: string }[] = [];

  for (const email of emails) {
    const status = STATUS_MAP[email.last_event] || "sent";
    const existing = existingMap.get(email.id);

    if (existing) {
      if (existing.status !== status) {
        toUpdate.push({ id: existing.id, status });
      }
    } else {
      toInsert.push({
        from: email.from,
        to: Array.isArray(email.to) ? email.to.join(", ") : (email.to || ""),
        subject: email.subject || "(no subject)",
        html: "",
        text: null,
        resend_id: email.id,
        status,
        created_at: email.created_at,
        updated_at: email.created_at,
        thread_id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      });
    }
  }

  // Batch insert new emails
  if (toInsert.length > 0) {
    const { error } = await supabase.from("emails").insert(toInsert);
    if (!error) imported = toInsert.length;
  }

  // Batch update statuses (Supabase doesn't support batch update, so do them concurrently)
  if (toUpdate.length > 0) {
    await Promise.all(
      toUpdate.map((u) =>
        supabase
          .from("emails")
          .update({ status: u.status, updated_at: new Date().toISOString() })
          .eq("id", u.id)
      )
    );
    updated = toUpdate.length;
  }

  return { imported, updated, total: emails.length };
}

/**
 * Full import: pages through ALL Resend emails.
 * Call this once to backfill, not on every page load.
 */
export async function fullImportFromResend(): Promise<{ imported: number; updated: number; total: number }> {
  let imported = 0;
  let updated = 0;
  let total = 0;
  let cursor: string | undefined;

  while (true) {
    const params: { limit: number; cursor?: string } = { limit: 100 };
    if (cursor) params.cursor = cursor;

    const result = await resend.emails.list(params);
    if (result.error || !result.data) break;

    const emails = result.data.data;
    if (!emails || emails.length === 0) break;

    total += emails.length;

    const resendIds = emails.map((e) => e.id);
    const { data: existingRows } = await supabase
      .from("emails")
      .select("id, resend_id, status")
      .in("resend_id", resendIds);

    const existingMap = new Map(
      (existingRows || []).map((row) => [row.resend_id, row])
    );

    const toInsert: Record<string, unknown>[] = [];

    for (const email of emails) {
      const status = STATUS_MAP[email.last_event] || "sent";
      const existing = existingMap.get(email.id);

      if (existing) {
        if (existing.status !== status) {
          await supabase
            .from("emails")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          updated++;
        }
      } else {
        toInsert.push({
          from: email.from,
          to: Array.isArray(email.to) ? email.to.join(", ") : (email.to || ""),
          subject: email.subject || "(no subject)",
          html: "",
          text: null,
          resend_id: email.id,
          status,
          created_at: email.created_at,
          updated_at: email.created_at,
          thread_id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        });
      }
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from("emails").insert(toInsert);
      if (!error) imported += toInsert.length;
    }

    if (emails.length < 100) break;
    cursor = emails[emails.length - 1].id;
  }

  return { imported, updated, total };
}
