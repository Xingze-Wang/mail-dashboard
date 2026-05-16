import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { syncContactByEmail } from "@/lib/miracleplus-sync";
import { REACHABLE_EMAIL_STATUSES } from "@/lib/status";

// Pro plan ceiling. The chunked design (CHUNK=50, ~5s/email serial, but
// we use 5 parallel workers so ~50s wall-clock) means we stay well
// under, but we set 300s to leave headroom for slow MP responses.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/sync-miracleplus-backfill
 *
 * Auth: Bearer $CRON_SECRET.
 *
 * Weekly self-heal for the miracleplus_contacts mirror. The daily
 * /api/cron/sync-miracleplus-contacts only resyncs the last 7 days of
 * outbound recipients; anything we emailed >7d ago and either (a) was
 * never mirrored or (b) was mirrored before MP's data on them updated
 * doesn't get re-checked. This route walks the full outbound history
 * one chunk at a time, picking up unmirrored emails and refreshing
 * MP's view of them.
 *
 * Chunking:
 *   - Reads cursor from cron_state.cron_name='mp_backfill' (default 0).
 *   - ?cursor=N overrides for manual resume.
 *   - Pulls up to PAGE distinct recipients from `emails` ordered by
 *     `to.asc` starting at offset=cursor, deduped + filtered to those
 *     not yet in miracleplus_contacts.
 *   - Processes up to CHUNK with 5 parallel MP search workers.
 *   - Writes the new cursor back to cron_state. When we hit the end
 *     of the email list, wraps cursor to 0 and sets last_completed_at
 *     — that's how we know a full pass finished.
 *
 * Why this is complementary to the daily 7-day sync:
 *   - Daily one keeps the hot tail (recent recipients) fresh.
 *   - This one slowly drains the long tail of older recipients we
 *     might have missed (e.g. cron ran while MP token was rotated,
 *     or the recipient existed in MP before they first received an
 *     email from us, etc).
 *
 * Scheduled at 0 4 * * 0 (Sunday 04:00 UTC = Sunday noon Beijing).
 */

const CHUNK = 50;
// Page size for pulling email recipients. We over-fetch because most
// of any batch is already mirrored; PAGE=400 gives us enough headroom
// to find CHUNK=50 unmirrored on a typical run.
const PAGE = 400;
const WORKERS = 5;
const CRON_NAME = "mp_backfill";

function canonicalEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const t = email.trim().toLowerCase();
  if (!t.includes("@")) return null;
  if (t.replace(/\*/g, "").length === 0) return null;
  return t;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ran_at = new Date().toISOString();
  const t0 = Date.now();

  // 1) Resolve cursor: ?cursor=N wins, else cron_state.cursor, else 0.
  const url = new URL(req.url);
  const cursorParam = url.searchParams.get("cursor");
  let cursor = 0;
  if (cursorParam !== null) {
    const n = parseInt(cursorParam, 10);
    if (Number.isFinite(n) && n >= 0) cursor = n;
  } else {
    const { data: stateRow } = await supabase
      .from("cron_state")
      .select("cursor")
      .eq("cron_name", CRON_NAME)
      .maybeSingle();
    cursor = typeof stateRow?.cursor === "number" ? stateRow.cursor : 0;
  }

  // 2) Pull a page of email recipients from outbound history.
  // Ordering by `to.asc` is stable across runs which is what makes the
  // offset-cursor scheme valid. Status filter mirrors the parallel
  // backfill script (REACHABLE only — no point checking bounced).
  const { data: emailRows, error: emailErr } = await supabase
    .from("emails")
    .select("to")
    .in("status", REACHABLE_EMAIL_STATUSES as readonly string[])
    .order("to", { ascending: true })
    .range(cursor, cursor + PAGE - 1);

  if (emailErr) {
    return NextResponse.json(
      { ok: false, ran_at, error: `emails fetch failed: ${emailErr.message}` },
      { status: 500 },
    );
  }

  const fetched = emailRows?.length ?? 0;
  const wrappedAtEnd = fetched < PAGE; // we hit the tail this run

  // 3) Dedupe canonicalized emails from this page.
  const uniq = new Set<string>();
  for (const r of emailRows ?? []) {
    const c = canonicalEmail(r.to as string | null);
    if (c) uniq.add(c);
  }

  // 4) Skip emails already mirrored.
  // For a chunk of a few hundred we use `.in()` which Supabase clamps
  // at ~1000 params — fine for PAGE=400.
  let alreadyMirrored = new Set<string>();
  if (uniq.size > 0) {
    const list = Array.from(uniq);
    const { data: mirroredRows } = await supabase
      .from("miracleplus_contacts")
      .select("email_canonical")
      .in("email_canonical", list);
    alreadyMirrored = new Set(
      (mirroredRows ?? [])
        .map((r) => r.email_canonical as string | null)
        .filter((x): x is string => !!x),
    );
  }

  const queue = Array.from(uniq).filter((e) => !alreadyMirrored.has(e)).slice(0, CHUNK);

  // 5) Parallel MP sync, up to CHUNK total.
  let checked = 0;
  let matched = 0;
  let errors = 0;
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= queue.length) return;
      const email = queue[idx];
      try {
        const r = await syncContactByEmail(email);
        checked++;
        if (r.matched > 0) matched++;
        if (r.error) errors++;
      } catch (err) {
        errors++;
        console.warn(
          "[mp-backfill] sync threw",
          { email, err: String(err).slice(0, 200) },
        );
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  // 6) Advance cursor.
  // Move past the entire fetched page (whether or not each row was
  // unmirrored) so we don't re-walk the same offset window next week.
  // If we hit the tail, wrap to 0 and mark a completed pass.
  const completed = wrappedAtEnd;
  const nextCursor = completed ? 0 : cursor + fetched;

  const meta = {
    last_batch: {
      cursor_in: cursor,
      cursor_out: nextCursor,
      fetched,
      uniq: uniq.size,
      already_mirrored: alreadyMirrored.size,
      processed: checked,
      matched,
      errors,
      ms: Date.now() - t0,
    },
  };

  // Upsert cron_state. Use UPSERT on PK so first run creates the row.
  const upsertPayload: Record<string, unknown> = {
    cron_name: CRON_NAME,
    cursor: nextCursor,
    last_run_at: ran_at,
    meta,
  };
  if (completed) upsertPayload.last_completed_at = ran_at;
  const { error: stateErr } = await supabase
    .from("cron_state")
    .upsert(upsertPayload, { onConflict: "cron_name" });
  if (stateErr) {
    console.warn("[mp-backfill] cron_state upsert failed", stateErr.message);
  }

  return NextResponse.json({
    ok: true,
    ran_at,
    cron: CRON_NAME,
    cursor_in: cursor,
    cursor_out: nextCursor,
    completed,
    fetched,
    uniq: uniq.size,
    already_mirrored: alreadyMirrored.size,
    processed: checked,
    matched,
    errors,
    ms: Date.now() - t0,
  });
}
