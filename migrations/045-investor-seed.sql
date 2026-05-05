-- migrations/045-investor-seed.sql
-- Seed two more investor agents to compete with the Founder.
-- Each investor has a stable id so attribution is reproducible across envs.

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
