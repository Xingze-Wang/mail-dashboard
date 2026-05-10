-- migrations/045-investor-seed.sql
--
-- 1. SCHEMA CHANGE
-- No schema changes. This is a data-only seed migration: inserts two
-- additional investor_agents rows (Atlas Capital, Bramble Holdings) and
-- their initial investor_capital_ledger pool_topups so they can compete
-- with the Founder investor seeded in migration 040.
--
-- 2. WHO WRITES
-- This migration only. Subsequent updates to these rows happen via
-- api/investor/* admin endpoints.
--
-- 3. WHO READS
-- - api/investor/tick (weekly capital deployment loop)
-- - /congress/timeline (investor lane on the timeline)
-- - investor synthesizer prompt context (default_conviction, style)
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — no pre-existing rows are touched. Both inserts
-- are guarded by ON CONFLICT (id) DO NOTHING / NOT EXISTS so re-runs
-- are no-ops on prod where the rows already exist.

insert into investor_agents (id, name, style, system_prompt, default_conviction)
values (
  '00000000-0000-0000-0000-000000000002',
  'Atlas Capital',
  'concentrated',
  'You are Atlas Capital. You concentrate capital in the highest-conviction company in the portfolio. When data is ambiguous, you double down on the leader rather than diversify. Your worst outcome is missing a 10x; your second-worst is over-diversifying into a flat portfolio.',
  0.6
)
on conflict (id) do nothing;

insert into investor_agents (id, name, style, system_prompt, default_conviction)
values (
  '00000000-0000-0000-0000-000000000003',
  'Bramble Holdings',
  'cautious',
  'You are Bramble Holdings. You require evidence before you allocate. You prefer 3 small bets that are slowly de-risking over 1 big bet on belief. You cut companies fast at the first signs of trouble. Your worst outcome is letting a losing company drain capital for weeks; your second-worst is missing a 10x because you waited for proof.',
  0.4
)
on conflict (id) do nothing;

-- Seed each with a starting capital pool.
insert into investor_capital_ledger (investor_id, kind, delta, balance_after, note)
select '00000000-0000-0000-0000-000000000002', 'pool_topup', 1000, 1000, 'Initial pool for Atlas Capital — migration 045.'
where not exists (select 1 from investor_capital_ledger where investor_id = '00000000-0000-0000-0000-000000000002');

insert into investor_capital_ledger (investor_id, kind, delta, balance_after, note)
select '00000000-0000-0000-0000-000000000003', 'pool_topup', 1000, 1000, 'Initial pool for Bramble Holdings — migration 045.'
where not exists (select 1 from investor_capital_ledger where investor_id = '00000000-0000-0000-0000-000000000003');
