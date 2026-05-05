-- migrations/047-bench-step-session-nullable.sql
-- 1. SCHEMA CHANGE
-- Make bench_step_results.session_id nullable. Originally enforced because
-- every step belonged to a sim session; backfill scripts and the
-- standalone weekly runner both produce step rows with no session, and
-- the constraint blocked them. We dropped it ad-hoc on the live DB
-- earlier — this migration locks that in for fresh envs.
--
-- 2. WHO WRITES   bench-sim runner, backfill scripts, congress-runners
-- 3. WHO READS    /congress/timeline, /api/bench/sim/[id]
-- 4. BACKFILL     none — column was already permissive; this normalizes schema

alter table bench_step_results alter column session_id drop not null;
