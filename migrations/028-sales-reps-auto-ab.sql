-- migrations/028-sales-reps-auto-ab.sql
--
-- 1. SCHEMA CHANGE
-- Adds sales_reps.auto_ab_enabled (boolean, default false). Per-rep
-- opt-in toggle for Dream #4 (auto-A/B applies high-confidence
-- patterns at draft generation time).
--
-- 2. WHO WRITES THIS?
-- Manual admin write today (no UI yet — flip via Supabase dashboard
-- or a TODO future /admin/reps/[id]/settings page). Default false
-- means new reps are NOT opted in until someone says so explicitly.
--
-- 3. WHO READS THIS?
-- src/lib/auto-ab.ts repHasAutoAbEnabled(). Called once per draft
-- generation in src/lib/email-generator.ts.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL/false forever for legacy rows. Default false
-- means existing reps stay opt-out. Admin manually enables per rep
-- once the segment they care about has enough confidence.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

alter table sales_reps
  add column if not exists auto_ab_enabled boolean not null default false;

notify pgrst, 'reload schema';
