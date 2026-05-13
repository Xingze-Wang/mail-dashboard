-- migrations/082-shared-pool-allocation.sql
--
-- 1. SCHEMA CHANGE
-- Adds three tables and one view for shared-pool allocation:
--   - rep_daily_quotas: standing per-rep per-pool daily quota set by admin
--   - rep_daily_quotas_override: one-shot quota overrides for a single date
--   - allocation_log: append-only audit trail of every lead allocation
--   - v_lead_pool: VIEW exposing unassigned leads tagged by sub-pool key
--
-- 2. WHO WRITES THIS?
-- rep_daily_quotas: POST /api/admin/missions/quotas (admin UI)
-- rep_daily_quotas_override: POST /api/admin/missions/quotas (override path)
-- allocation_log: GET/POST /api/missions/allocate-leads (cron + admin trigger)
--                 and POST /api/admin/allocation/override (per-rep re-allocate)
-- v_lead_pool: not written — derived view
--
-- 3. WHO READS THIS?
-- rep_daily_quotas: GET /api/admin/missions/quotas (panel), heuristic-seed cron
-- rep_daily_quotas_override: heuristic-seed cron (overrides standing quota for that date)
-- allocation_log: GET /api/admin/allocation (cockpit), allocate-leads (idempotency)
-- v_lead_pool: allocate-leads cron, GET /api/admin/allocation (pool inventory)
--
-- 4. BACKFILL FOR OLD ROWS
-- rep_daily_quotas: (a) one-shot INSERT in this migration seeds a row per
--   currently-active sales rep mirroring today's routing (Leo all-strong,
--   Yujie all-cn, Ethan all-overseas, Chenyu small-cn). Numbers below are
--   conservative defaults; admin can edit immediately from /admin/missions.
-- rep_daily_quotas_override: (d) not applicable — new table, no legacy rows
-- allocation_log: (d) not applicable — new table, no legacy rows
-- v_lead_pool: (d) not applicable — view, computed on read
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

CREATE TABLE IF NOT EXISTS rep_daily_quotas (
  rep_id integer PRIMARY KEY REFERENCES sales_reps(id) ON DELETE CASCADE,
  per_pool jsonb NOT NULL DEFAULT '{}'::jsonb,
  direction_priority text[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_by_rep_id integer REFERENCES sales_reps(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rep_daily_quotas_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id integer NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  per_pool jsonb NOT NULL,
  reason text,
  created_by_rep_id integer REFERENCES sales_reps(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rep_id, due_date)
);
CREATE INDEX IF NOT EXISTS idx_rep_daily_quotas_override_date
  ON rep_daily_quotas_override(due_date DESC);

CREATE TABLE IF NOT EXISTS allocation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid REFERENCES missions(id),
  rep_id integer NOT NULL REFERENCES sales_reps(id),
  due_date date NOT NULL,
  pool_key text NOT NULL,
  lead_ids uuid[] NOT NULL,
  allocator text NOT NULL,
  reason text,
  notification_status text,
  notification_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allocation_log_due_date
  ON allocation_log(due_date DESC);
CREATE INDEX IF NOT EXISTS idx_allocation_log_rep
  ON allocation_log(rep_id, due_date DESC);

CREATE OR REPLACE VIEW v_lead_pool AS
SELECT
  id,
  person_id,
  author_email,
  author_name,
  lead_tier,
  school_tier,
  citation_count,
  h_index,
  matched_directions,
  local_score,
  CASE
    WHEN author_email ILIKE '%.cn' THEN 'cn'
    WHEN author_email ILIKE '%.edu' THEN 'edu'
    ELSE 'other'
  END AS geo,
  CASE
    WHEN lead_tier = 'strong' THEN 'strong'
    WHEN lead_tier = 'normal' AND (author_email ILIKE '%.cn') THEN 'normal_cn'
    WHEN lead_tier = 'normal' AND (author_email ILIKE '%.edu') THEN 'normal_edu'
    ELSE 'normal_overseas'
  END AS pool_key,
  created_at
FROM pipeline_leads
WHERE assigned_rep_id IS NULL
  AND status IN ('new', 'queued');

-- Backfill: seed rep_daily_quotas for currently active sales reps.
-- Conservative starting numbers; admin will tune from /admin/missions.
-- We use a CTE so the migration is idempotent (re-run safe).
INSERT INTO rep_daily_quotas (rep_id, per_pool)
SELECT id, CASE
  WHEN lower(name) = 'leo'    THEN '{"strong":8,"normal_cn":0,"normal_overseas":0,"normal_edu":0}'::jsonb
  WHEN lower(name) = 'yujie'  THEN '{"strong":0,"normal_cn":12,"normal_overseas":0,"normal_edu":0}'::jsonb
  WHEN lower(name) = 'ethan'  THEN '{"strong":0,"normal_cn":0,"normal_overseas":10,"normal_edu":2}'::jsonb
  WHEN lower(name) = 'chenyu' THEN '{"strong":0,"normal_cn":6,"normal_overseas":0,"normal_edu":0}'::jsonb
  ELSE '{"strong":0,"normal_cn":0,"normal_overseas":0,"normal_edu":0}'::jsonb
END
FROM sales_reps
WHERE active = true
  AND id NOT IN (SELECT rep_id FROM rep_daily_quotas);
