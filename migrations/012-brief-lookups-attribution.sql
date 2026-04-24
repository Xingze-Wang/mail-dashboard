-- ═══════════════════════════════════════════════════════════════════
-- Migration 012: Brief lookups attribution
--
-- Adds rep attribution to `brief_lookups` so admin can audit WeChat
-- conversion marks. Before this, /api/brief/wechat POSTed to the
-- table with no record of which rep clicked "Added on WeChat" —
-- which made per-rep conversion stats impossible to compute.
--
-- Brief search itself stays cross-rep by product design (when
-- someone adds a rep on WeChat, any rep may need to look them up),
-- but the conversion-mark event now tracks who did it.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table brief_lookups
  add column if not exists marked_by_rep_id integer;
alter table brief_lookups
  add column if not exists marked_by_email  text;

create index if not exists idx_brief_lookups_marked_by
  on brief_lookups (marked_by_rep_id) where marked_by_rep_id is not null;
