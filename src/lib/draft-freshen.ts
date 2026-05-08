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
 * Scan an HTML draft for "stale rep name" markers — names that don't
 * match the rep that's actually about to send. Returns a freshened
 * version of the html + subject if drift is found, or the originals
 * untouched if not.
 *
 * The detection set is build from a fixed list of recently-known-rep
 * names: anything that USED TO BE a sales_reps name but doesn't match
 * THIS rep's current sender_name. We pull the list dynamically so as
 * reps come and go the catch-list updates.
 *
 * Returns { html, subject, swapped: boolean, swappedFrom?: string }.
 * `swapped=false` means the draft was already fresh. Callers should
 * persist back to pipeline_leads.draft_html on swap=true so future
 * reads see the corrected version (and analytics line up).
 */
export async function freshenDraftForRep(args: {
  draftHtml: string | null | undefined;
  draftSubject: string | null | undefined;
  /** The rep this email is being sent AS. */
  currentSenderName: string;
}): Promise<{
  html: string;
  subject: string;
  swapped: boolean;
  swappedFrom?: string;
}> {
  const html = args.draftHtml ?? "";
  const subject = args.draftSubject ?? "";
  const target = args.currentSenderName.trim();

  if (!html || !target) {
    return { html, subject, swapped: false };
  }

  // Pull the historical "things that were once a rep name" set. This
  // is the live sales_reps.name + sales_reps.sender_name across all
  // rows. If a draft mentions one of these strings AND the string isn't
  // our current target, it's drift.
  // We don't depend on knowing whether they were renamed — any name
  // that ISN'T the current sender_name is presumed wrong.
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("name, sender_name");
  const knownNames = new Set<string>();
  for (const r of reps ?? []) {
    if (r.name && r.name !== target) knownNames.add(r.name as string);
    if (r.sender_name && r.sender_name !== target) knownNames.add(r.sender_name as string);
  }

  // Hard-coded historical names that no longer have a sales_reps row
  // but might still be baked into older drafts. Add to this set when
  // a rename happens — the cheap insurance is worth the line.
  // (Migration 053 renamed Chenyu → Yujie / 杜雨洁; Chenyu has no row
  // anymore so it wouldn't appear in the dynamic set above.)
  const HISTORICAL_NAMES = ["Chenyu", "chenyu"];
  for (const n of HISTORICAL_NAMES) knownNames.add(n);

  // Build deterministic order so the swap is repeatable: longest first
  // so "Chenyu" replaces before "Chen" (avoid prefix-replacement bugs).
  const orderedNames = [...knownNames].sort((a, b) => b.length - a.length);

  let newHtml = html;
  let newSubject = subject;
  let swapped = false;
  let swappedFrom: string | undefined;
  for (const wrongName of orderedNames) {
    if (newHtml.includes(wrongName) || newSubject.includes(wrongName)) {
      newHtml = newHtml.split(wrongName).join(target);
      newSubject = newSubject.split(wrongName).join(target);
      swapped = true;
      swappedFrom ??= wrongName;
    }
  }

  return { html: newHtml, subject: newSubject, swapped, swappedFrom };
}
