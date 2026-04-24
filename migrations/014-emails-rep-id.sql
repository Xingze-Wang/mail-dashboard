-- ═══════════════════════════════════════════════════════════════════
-- Migration 014: rep_id columns on emails + inbound_emails
--
-- Today, /api/inbox/unread-count, /api/inbound, /api/emails, and
-- /api/metrics scope non-admin users by `emails.from ilike sender_email`
-- — a proxy filter. If a rep's sender_email ever changes in sales_reps,
-- their entire historical email scope breaks silently (unread goes to
-- zero, inbox empties, metrics stop counting them). The canonical field
-- to scope by is sales_reps.id.
--
-- This migration ADDS the columns and back-fills them from current
-- sender_email matches. It does NOT flip the routes yet — a follow-up
-- code change will swap the filters once we trust the column is
-- populated in prod. Keeping the sender_email fallback meanwhile means
-- old rows that don't match any active rep (historical sender_emails,
-- seed data) stay visible.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table emails
  add column if not exists rep_id integer;
alter table inbound_emails
  add column if not exists rep_id integer;

-- Back-fill: match each outbound email's `from` substring to an active
-- rep's sender_email. Using ilike so casing and "Name <addr>" wrappers
-- don't break the match. Only overwrites rep_id=null rows so re-runs
-- are safe and manual assignments (if any) are preserved.
update emails e
set    rep_id = r.id
from   sales_reps r
where  e.rep_id is null
  and  r.active is true
  and  r.sender_email is not null
  and  e.from is not null
  and  e.from ilike '%' || r.sender_email || '%';

-- For inbound_emails, rep attribution is by thread: we owned the thread
-- if an outbound email on that thread has a rep_id. Two-step join so
-- the UPDATE ... FROM stays readable.
update inbound_emails i
set    rep_id = e.rep_id
from   emails e
where  i.rep_id is null
  and  i.thread_id is not null
  and  e.thread_id = i.thread_id
  and  e.rep_id is not null;

create index if not exists idx_emails_rep_id
  on emails (rep_id) where rep_id is not null;
create index if not exists idx_inbound_emails_rep_id
  on inbound_emails (rep_id) where rep_id is not null;
