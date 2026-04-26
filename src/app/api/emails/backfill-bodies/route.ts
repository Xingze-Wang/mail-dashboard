import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { requireAdmin } from "@/lib/auth-helpers";

// Backfill emails.text / emails.html from Resend for rows where the
// legacy Python pipeline never persisted the body. Search by recipient
// name (e.g. "Shuicheng") couldn't find anything for ~1100 historical
// rows because the body column was empty even though Resend has it.
//
// Admin-only POST. Processes BATCH rows per call, paced to stay under
// Resend's 10 req/s cap. Call repeatedly until `remaining` is 0.

export const maxDuration = 300;
const BATCH = 60;          // ~6 seconds at 10 rps with margin
const PER_CALL_DELAY_MS = 110;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  // Pull a batch of rows that have a resend_id but missing both text AND html.
  // We don't backfill rows missing only one of the two — partial body is
  // already searchable.
  const { data: rows } = await supabase
    .from("emails")
    .select("id, resend_id, text, html")
    .not("resend_id", "is", null)
    .or("text.is.null,text.eq.")
    .or("html.is.null,html.eq.")
    .order("created_at", { ascending: false })
    .limit(BATCH);

  if (!rows || rows.length === 0) {
    return NextResponse.json({ processed: 0, updated: 0, remaining: 0 });
  }

  let updated = 0;
  let resendMissing = 0;
  let errored = 0;

  for (const row of rows) {
    try {
      const fetched = await resend.emails.get(row.resend_id as string);
      // Resend returns { data, error }. If the email is older than their
      // retention or the id is wrong, data is null.
      if (!fetched.data) {
        resendMissing++;
        continue;
      }
      const html = fetched.data.html || null;
      const text = fetched.data.text || null;
      if (isEmpty(html) && isEmpty(text)) {
        resendMissing++;
        continue;
      }
      // Don't overwrite a column that already has content — only fill
      // what's empty. Some rows have html but not text (or vice versa).
      const update: { html?: string | null; text?: string | null } = {};
      if (isEmpty(row.html) && !isEmpty(html)) update.html = html;
      if (isEmpty(row.text) && !isEmpty(text)) update.text = text;
      if (Object.keys(update).length === 0) continue;

      const { error } = await supabase.from("emails").update(update).eq("id", row.id);
      if (error) {
        errored++;
        console.error("emails backfill update failed", { id: row.id, err: error.message });
      } else {
        updated++;
      }
    } catch (err) {
      errored++;
      console.error("emails backfill resend.get failed", { id: row.id, err: String(err) });
    }
    // Pace to keep under Resend's 10 rps cap. ~110ms = ~9 rps.
    await new Promise((r) => setTimeout(r, PER_CALL_DELAY_MS));
  }

  // Report what's left so the operator knows whether to call again.
  const { count: remaining } = await supabase
    .from("emails")
    .select("*", { count: "exact", head: true })
    .not("resend_id", "is", null)
    .or("text.is.null,text.eq.")
    .or("html.is.null,html.eq.");

  return NextResponse.json({
    processed: rows.length,
    updated,
    resendMissing,
    errored,
    remaining: remaining ?? 0,
  });
}
