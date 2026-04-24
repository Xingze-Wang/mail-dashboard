-- ═══════════════════════════════════════════════════════════════════
-- Migration 009: Proactive chime-in for the sales helper
--
-- Adds `pending_chime_in` to `helper_rep_state`. A daily cron
-- (/api/cron/proactive-signals) scans per-rep activity and, when a
-- hard-coded signal rule trips, writes a JSON blob here describing
-- what the helper should mention the next time the rep opens the
-- chat (pull-style — never auto-pops the chat).
--
-- Consumed by /api/help/opening, which prepends the chime-in above
-- the daily opener message. Client clears it via the consume endpoint
-- once shown.
--
-- Shape (v1, just "heavy editor" rule):
--   {
--     "type": "voice_capture_offer",
--     "edit_count": 5,
--     "window_days": 7,
--     "detected_at": "2026-04-23T01:30:00Z"
--   }
--
-- Other types will share this slot (only one pending at a time — the
-- newer signal overwrites the older; rep hasn't acted on the old one
-- anyway). If we ever need a queue, this becomes an array column.
-- ═══════════════════════════════════════════════════════════════════

alter table helper_rep_state
  add column if not exists pending_chime_in jsonb;
