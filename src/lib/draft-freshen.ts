/**
 * Draft staleness check + repair, applied at SEND time.
 *
 * Why this exists: drafts are rendered eagerly (at scan / import / queue
 * time) so the rep sees something on /pipeline immediately. They sit in
 * `pipeline_leads.draft_html` for hours-to-weeks before send. Anything
 * that changes about the rep in that window (rename, sender_name swap,
 * reassignment) leaves the draft stale — pre-rename "Chenyu" drafts
 * went out the door labeled with an old name even after the rename.
 *
 * The expensive fix would be "re-render every draft on every send via
 * the LLM". That's wasteful — 99% of stale-draft cases are just a
 * stale REP NAME baked into the rep-intro paragraph or signature.
 *
 * This module ships the cheap fix: detect rep-name drift via string
 * scan and swap in-place. If the draft references a name that doesn't
 * match the current rep's sender_name, swap the wrong name out. We
 * leave the LLM-generated intro paragraph alone (low chance of
 * containing a rep name; high cost to re-render).
 *
 * The principle behind this (per the user's guidance): "谁发就写谁,
 * 谁点开就写谁，永远是一个动态的过程" — name-of-record is the
 * action-time identity, not the snapshot-at-creation identity.
 */

import { supabase } from "./db";

/**
 * Scan an HTML draft for stale rep-bound fields — names AND wechat ids
 * AND any other identity-coupled string baked in at scan time that no
 * longer matches the rep about to send. Returns a freshened version
 * of the html + subject if drift is found, or originals if not.
 *
 * Detection sets are pulled dynamically from sales_reps so the catch
 * list updates as reps come and go. We swap any non-target value to
 * the current target. We don't depend on knowing the prior value.
 *
 * Returns { html, subject, swapped, swaps[] } where swaps lists each
 * (kind, from, to) for logging/audit. Callers should persist html +
 * subject back to pipeline_leads on swapped=true so future reads +
 * analytics see the corrected version.
 */
export async function freshenDraftForRep(args: {
  draftHtml: string | null | undefined;
  draftSubject: string | null | undefined;
  /** The rep this email is being sent AS. */
  currentSenderName: string;
  /** The wechat_id of the rep this email is being sent AS. */
  currentWechatId?: string | null;
}): Promise<{
  html: string;
  subject: string;
  swapped: boolean;
  swappedFrom?: string;
  swaps: Array<{ kind: "name" | "wechat"; from: string; to: string }>;
}> {
  const html = args.draftHtml ?? "";
  const subject = args.draftSubject ?? "";
  const targetName = args.currentSenderName.trim();
  const targetWechat = (args.currentWechatId ?? "").trim();

  if (!html || !targetName) {
    return { html, subject, swapped: false, swaps: [] };
  }

  // Pull all rep-bound identity fields. Any value here that isn't this
  // rep's current value is drift if it shows up in the draft.
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("name, sender_name, wechat_id");

  const wrongNames = new Set<string>();
  const wrongWechats = new Set<string>();
  for (const r of reps ?? []) {
    if (r.name && r.name !== targetName) wrongNames.add(r.name as string);
    if (r.sender_name && r.sender_name !== targetName) wrongNames.add(r.sender_name as string);
    if (r.wechat_id && targetWechat && r.wechat_id !== targetWechat) {
      wrongWechats.add(r.wechat_id as string);
    }
  }

  // Hard-coded historical strings that no longer have a sales_reps row
  // but might still be baked into older drafts. Add when a rename
  // happens. Migration 053 renamed Chenyu → Yujie/杜雨洁 — no sales_reps
  // row carries 'Chenyu' anymore so it wouldn't appear dynamically.
  const HISTORICAL_NAMES = ["Chenyu", "chenyu"];
  for (const n of HISTORICAL_NAMES) {
    if (n !== targetName) wrongNames.add(n);
  }

  // Longest-first sort so "Chenyu" replaces before "Chen" — avoids
  // prefix-replacement bugs where a substring of one name eats another.
  const orderedNames = [...wrongNames].sort((a, b) => b.length - a.length);
  const orderedWechats = [...wrongWechats].sort((a, b) => b.length - a.length);

  let newHtml = html;
  let newSubject = subject;
  const swaps: Array<{ kind: "name" | "wechat"; from: string; to: string }> = [];

  for (const wrongName of orderedNames) {
    if (newHtml.includes(wrongName) || newSubject.includes(wrongName)) {
      newHtml = newHtml.split(wrongName).join(targetName);
      newSubject = newSubject.split(wrongName).join(targetName);
      swaps.push({ kind: "name", from: wrongName, to: targetName });
    }
  }

  // Wechat swaps are body-only (subject lines never contain wechat ids).
  // We still write through targetWechat into the subject if there were
  // false positives — but in practice swaps[].kind='wechat' will only
  // affect newHtml.
  if (targetWechat) {
    for (const wrongWechat of orderedWechats) {
      if (newHtml.includes(wrongWechat)) {
        newHtml = newHtml.split(wrongWechat).join(targetWechat);
        swaps.push({ kind: "wechat", from: wrongWechat, to: targetWechat });
      }
    }
  }

  const swapped = swaps.length > 0;
  return {
    html: newHtml,
    subject: newSubject,
    swapped,
    swappedFrom: swaps[0]?.from,
    swaps,
  };
}
