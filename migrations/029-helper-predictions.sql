-- migrations/029-helper-predictions.sql
--
-- 1. SCHEMA CHANGE
-- New table helper_predictions for Dream #5 (prediction → outcome →
-- self-critique loop). Each row is one falsifiable claim the helper
-- made ("this lead won't reply because X"), with its target event,
-- target window, and resolution status.
--
-- 2. WHO WRITES THIS?
-- src/app/api/help/predictions/route.ts (POST) — the rep clicks a
-- "track this" button on a helper bubble that contains a prediction.
-- Helper-side only (no auto-mining for now); user opt-in keeps the
-- table clean.
--
-- 3. WHO READS THIS?
-- (a) /api/help/predictions/resolve cron pass — each unresolved
-- prediction past its target_window gets resolved against actual
-- data and marked correct/wrong. Wrong ones write a self_critique
-- row into helper_learnings.
-- (b) /api/help/predictions/recent — admin-only, see what helper
-- has been predicting and how often it's right.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new table, no old rows.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

create table if not exists helper_predictions (
  id              uuid primary key default gen_random_uuid(),
  rep_id          integer not null,
  conversation_id uuid,
  message_id      uuid,
  -- The claim itself, in natural language. e.g. "this lead won't
  -- reply because they're industry and we hit them with academic hook"
  claim           text not null,
  -- What event would make the claim TRUE. Today: "no_reply" |
  -- "no_wechat" | "reply" | "wechat". Loose enum — cron resolver
  -- knows the four shapes; unknown values stay unresolved forever.
  target_event    text not null,
  target_lead_id  text,
  target_recipient text,
  -- ISO timestamp by which the event must (or must not) have
  -- happened for the claim to count.
  target_deadline timestamptz not null,
  made_at         timestamptz not null default now(),
  -- null = unresolved, true = claim was correct, false = wrong
  resolved_correct boolean,
  resolved_at     timestamptz,
  resolution_note text
);

create index if not exists idx_helper_pred_rep on helper_predictions (rep_id, made_at desc);
create index if not exists idx_helper_pred_unresolved on helper_predictions (target_deadline)
  where resolved_correct is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'helper_predictions'::regclass
      and conname = 'helper_predictions_rep_id_fkey'
  ) then
    alter table helper_predictions
      add constraint helper_predictions_rep_id_fkey
      foreign key (rep_id) references sales_reps(id) on delete cascade;
  end if;
end $$;

notify pgrst, 'reload schema';
