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
 * Sync ALL sent emails and inbound emails from Resend into Supabase.
 * Uses `has_more` from the API response for reliable pagination.
 */
export async function syncFromResend(
  timeBudgetMs = 8000
): Promise<{ imported: number; updated: number; inboundImported: number; total: number; complete: boolean; errors: string[] }> {
  let imported = 0;
  let updated = 0;
  let inboundImported = 0;
  let total = 0;
  let after: string | undefined;
  const errors: string[] = [];
  const start = Date.now();

  // ── Phase 1: Sync sent emails ──
  let hasMore = true;
  while (hasMore) {
    if (Date.now() - start > timeBudgetMs) {
      return { imported, updated, inboundImported, total, complete: false, errors };
    }

    const params: { limit: number; after?: string } = { limit: 100 };
    if (after) params.after = after;
    if (after) await new Promise((r) => setTimeout(r, 250));

    const result = await resend.emails.list(params);
    if (result.error || !result.data) break;

    const emails = result.data.data;
    hasMore = result.data.has_more;
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

    if (toInsert.length > 0) {
      const { error } = await supabase.from("emails").insert(toInsert);
      if (error) {
        errors.push(`insert(${toInsert.length}): ${error.message}`);
      } else {
        imported += toInsert.length;
      }
    }

    if (toUpdate.length > 0) {
      await Promise.all(
        toUpdate.map((u) =>
          supabase
            .from("emails")
            .update({ status: u.status, updated_at: new Date().toISOString() })
            .eq("id", u.id)
        )
      );
      updated += toUpdate.length;
    }

    // If entire page already existed with correct statuses, sent sync is caught up
    if (toInsert.length === 0 && toUpdate.length === 0) break;

    after = emails[emails.length - 1].id;
  }

  // ── Phase 2: Sync inbound/received emails ──
  let inboundAfter: string | undefined;
  let inboundHasMore = true;
  while (inboundHasMore) {
    if (Date.now() - start > timeBudgetMs) {
      return { imported, updated, inboundImported, total, complete: false, errors };
    }

    const params: { limit: number; after?: string } = { limit: 100 };
    if (inboundAfter) params.after = inboundAfter;
    if (inboundAfter) await new Promise((r) => setTimeout(r, 250));

    try {
      const result = await resend.emails.receiving.list(params);
      if (!result.data) break;

      const emails = result.data.data;
      inboundHasMore = result.data.has_more;
      if (!emails || emails.length === 0) break;

      // Check which already exist — look up by both Resend UUID and real message_id
      const resendIds = emails.map((e) => e.id);
      const realMsgIds = emails
        .map((e) => (e as unknown as Record<string, unknown>).message_id as string)
        .filter(Boolean);
      const allLookupIds = [...new Set([...resendIds, ...realMsgIds])];

      const { data: existingRows } = await supabase
        .from("inbound_emails")
        .select("id, message_id")
        .in("message_id", allLookupIds);

      const existingSet = new Set((existingRows || []).map((r) => r.message_id));

      for (const email of emails) {
        const realMsgId = (email as unknown as Record<string, unknown>).message_id as string;
        if (existingSet.has(email.id) || (realMsgId && existingSet.has(realMsgId))) continue;
        if (Date.now() - start > timeBudgetMs) {
          return { imported, updated, inboundImported, total, complete: false, errors };
        }

        // Fetch full email content from Resend
        let html: string | null = null;
        let text: string | null = null;
        try {
          await new Promise((r) => setTimeout(r, 250)); // rate limit
          const full = await resend.emails.receiving.get(email.id);
          if (full.data) {
            html = full.data.html || null;
            text = full.data.text || null;
          }
        } catch {
          // Fall back to no content
        }

        // Use real email Message-ID if available, fall back to Resend UUID
        const realMessageId = (email as Record<string, unknown>).message_id as string || email.id;

        const { error } = await supabase.from("inbound_emails").insert({
          from: email.from,
          to: Array.isArray(email.to) ? email.to.join(", ") : (email.to || ""),
          subject: email.subject || "(no subject)",
          html,
          text,
          message_id: realMessageId,
          in_reply_to: (email as Record<string, unknown>).in_reply_to as string || null,
          thread_id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          created_at: email.created_at,
        });

        if (error) {
          errors.push(`inbound_insert: ${error.message}`);
        } else {
          inboundImported++;
        }
      }

      inboundAfter = emails[emails.length - 1].id;
    } catch (e: unknown) {
      errors.push(`inbound: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }

  // ── Phase 3: Backfill content + fix message_id for inbound emails ──
  try {
    // Find inbound emails that need content or have UUID-style message_ids
    const { data: needsFix } = await supabase
      .from("inbound_emails")
      .select("id, message_id")
      .limit(20);

    for (const row of needsFix || []) {
      if (Date.now() - start > timeBudgetMs) {
        return { imported, updated, inboundImported, total, complete: false, errors };
      }
      if (!row.message_id) continue;

      try {
        await new Promise((r) => setTimeout(r, 250));
        const full = await resend.emails.receiving.get(row.message_id);
        if (full.data) {
          const updates: Record<string, unknown> = {};
          if (full.data.html) updates.html = full.data.html;
          if (full.data.text) updates.text = full.data.text;
          // Fix message_id to real email Message-ID if available
          const realMsgId = (full.data as unknown as Record<string, unknown>).message_id as string;
          if (realMsgId && realMsgId !== row.message_id) {
            updates.message_id = realMsgId;
          }
          if (Object.keys(updates).length > 0) {
            await supabase.from("inbound_emails").update(updates).eq("id", row.id);
          }
        }
      } catch {
        // Skip if fetch fails
      }
    }
  } catch {
    // Backfill is best-effort
  }

  return { imported, updated, inboundImported, total, complete: true, errors };
}
