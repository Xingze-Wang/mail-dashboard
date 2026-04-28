-- Tier 2 of docs/DATA_INTEGRITY_PLAN.md
--
-- Why this exists:
--   `emails.status` is *latest-event-wins*. If a recipient clicks an
--   email and then later complains, the row's status moves to
--   'complained' and any analytics query asking "did this email ever
--   get clicked?" returns false. We've patched 5+ specific instances
--   of this — every analytics query now has to know to UNION the
--   `emails.status` history with `webhook_events.type='email.clicked'`.
--   That's the lint rule we want to enforce, but the structural fix is
--   to give every query *one place* to read the boolean signals from.
--
-- What this view gives you:
--   For each outbound email, a row with boolean columns for each
--   ever-occurred lifecycle event:
--     was_sent / was_delivered / was_opened / was_clicked /
--     was_bounced / was_complained
--   Plus first_clicked_at, last_clicked_at, click_count for the
--   per-recipient click history (Tier 0/1 work).
--
-- How to use it:
--   - Metrics queries: read `email_history` instead of `emails.status`.
--   - Inbox UI: keep using `emails.status` (latest event is what you
--     want to display in a thread list — "complained" should win
--     visually over "clicked", because the action was negative).
--
-- Cost note: this is a view, not a materialized view. It re-runs the
-- aggregation every time. webhook_events is currently small (will
-- grow as Tier 0 fix lands actual events) but indexed on
-- (email_id, type), so the join is cheap. If it ever bites, promote
-- to a materialized view refreshed on the cron pass.

create or replace view email_history as
select
  e.id                              as email_id,
  e.resend_id,
  e."from"                          as from_address,
  e."to"                            as to_address,
  e.subject,
  e.created_at,
  e.thread_id,
  e.rep_id,
  -- Latest-state mirror of emails.status, kept for convenience so
  -- callers don't always need a join back. Use the booleans below
  -- for "ever-happened" questions.
  e.status                          as latest_status,
  -- Was-it-ever booleans. Logic: union of (a) any matching row in
  -- webhook_events and (b) the latest emails.status when it matches.
  -- The fallback to emails.status matters for legacy rows whose
  -- webhook_events are missing entirely (Tier 0 was broken until
  -- 2026-04-27, so the only signal for older clicks is the cron sync
  -- that wrote emails.status). Once webhook history is full, both
  -- signals agree and the (b) branch is redundant — leaving it in
  -- keeps us safe during backfill.
  coalesce(bool_or(w.type = 'email.sent'),       false) or e.status = 'sent'       as was_sent,
  coalesce(bool_or(w.type = 'email.delivered'),  false) or e.status = 'delivered'  as was_delivered,
  coalesce(bool_or(w.type = 'email.opened'),     false) or e.status = 'opened'     as was_opened,
  coalesce(bool_or(w.type = 'email.clicked'),    false) or e.status = 'clicked'    as was_clicked,
  coalesce(bool_or(w.type = 'email.bounced'),    false) or e.status = 'bounced'    as was_bounced,
  coalesce(bool_or(w.type = 'email.complained'), false) or e.status = 'complained' as was_complained,
  -- Click history aggregates. Multi-click capture means a recipient
  -- exploring the email shows up as multiple rows.
  count(*) filter (where w.type = 'email.clicked') as click_count,
  min(case when w.type = 'email.clicked' then w.created_at end) as first_clicked_at,
  max(case when w.type = 'email.clicked' then w.created_at end) as last_clicked_at
from emails e
left join webhook_events w
  on w.email_id = e.id
group by e.id;

comment on view email_history is
  'Per-email lifecycle truth: derived from webhook_events (the canonical event log) joined to emails. Use this — not emails.status — for any "did X ever happen?" analytics question. See docs/DATA_INTEGRITY_PLAN.md Tier 2.';
