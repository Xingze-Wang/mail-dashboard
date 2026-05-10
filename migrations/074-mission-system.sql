-- 074-mission-system.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- Four-layer mission primitive — solves "reps don't have a great
-- idea of what to do or what to work on, kind of know the drill but
-- there's no mission system":
--
--   Quarterly goals — destination ("200 wechat conversions this Q")
--   Team focus      — path for the week ("focus on cn-tier1 this week")
--   Daily missions  — per-rep action items ("send 8 to cn-tier1 today")
--   Visibility      — derived view: see what teammates are doing
--
-- All four resolutions of the same primitive: a target with a scope.
-- Stored separately so the read-side can surface them differently
-- (banner vs. checklist vs. progress bar).
--
-- Generation:
--   - quarterly_goals: admin sets manually (low cadence, big stakes)
--   - team_focus     : weekly congress synthesizer proposes; admin
--                      approves. Falls back to last week's if congress
--                      hasn't run.
--   - missions       : weekly congress proposes per-rep set for the
--                      upcoming week; admin approves. Heuristic
--                      fallback (look at queue depth) when no
--                      proposal exists.
--
-- 2. WHO WRITES
--   - quarterly_goals: POST /api/admin/goals (admin only)
--   - team_focus     : POST /api/admin/focus (admin only); also auto-
--                      written when admin approves a congress
--                      mission_proposal
--   - missions       : POST /api/admin/missions (admin only) — inserted
--                      in batch on approval; also direct admin authoring
--   - mission_progress: incremented by triggers / app code on send /
--                      reply / wechat mark
--
-- 3. WHO READS
--   - /missions      : rep's daily view (today's missions, team focus,
--                      quarterly progress, teammates' progress)
--   - /admin/missions: admin authoring + approval surface
--
-- 4. BACKFILL
--   Empty start. No retroactive mission creation — would be noise.
--   First values appear when admin sets first quarterly goal.

CREATE TABLE IF NOT EXISTS quarterly_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quarter_starting  date NOT NULL,   -- e.g. 2026-04-01 = Q2 2026
  -- Free-form metric name. Examples: 'wechat_conversions', 'replies',
  -- 'unique_persons_reached'. Read-side joins to actual stats by name.
  metric          text NOT NULL,
  target          int  NOT NULL CHECK (target > 0),
  unit            text NOT NULL DEFAULT 'count',
  description     text,
  set_by_rep_id   int  REFERENCES sales_reps(id),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Only one active goal per (quarter, metric) — prevents fights.
CREATE UNIQUE INDEX IF NOT EXISTS quarterly_goals_unique_active
  ON quarterly_goals (quarter_starting, metric)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS team_focus (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monday of the week this focus is for. Always a Monday by
  -- convention so weekly cron can trivially compute the target row.
  week_starting   date NOT NULL,
  -- Short headline ("This week: cn-tier1 conversion") + rationale.
  theme           text NOT NULL,
  rationale       text,
  set_by          text NOT NULL CHECK (set_by IN ('congress', 'admin')),
  congress_run_id uuid REFERENCES congress_runs(id),
  set_by_rep_id   int  REFERENCES sales_reps(id),
  -- Approval state. Congress-set themes start status='proposed' and
  -- only show on /missions when approved. Admin-set themes can skip
  -- straight to 'active' since the admin IS the approver.
  status          text NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed', 'active', 'rejected', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  approved_by_rep_id int REFERENCES sales_reps(id)
);

-- One active focus per week.
CREATE UNIQUE INDEX IF NOT EXISTS team_focus_one_active_per_week
  ON team_focus (week_starting)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS team_focus_status_idx
  ON team_focus (status, week_starting DESC);

CREATE TABLE IF NOT EXISTS missions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          int  NOT NULL REFERENCES sales_reps(id),
  -- ISO date of the day this mission is FOR. We use date (not
  -- timestamptz) so timezone arithmetic doesn't bite — a mission
  -- is "for Monday" regardless of the rep's timezone.
  due_date        date NOT NULL,

  -- The action shape:
  --   'send'           — send N emails (optionally filtered by segment)
  --   'reply'          — reply to N inbound emails
  --   'mark_wechat'    — confirm wechat conversions in /brief
  --   'review_proposals' — admin-only: review pending congress proposals
  --   'review_template_edits' — admin-only: pending template_edits queue
  kind            text NOT NULL CHECK (kind IN (
    'send', 'reply', 'mark_wechat', 'review_proposals',
    'review_template_edits', 'custom'
  )),

  target          int  NOT NULL CHECK (target > 0),
  -- Optional segment scoping for 'send' kind. e.g. {segment: 'cn',
  -- school_tier: 1}. Stored as jsonb for flexibility.
  scope           jsonb DEFAULT '{}'::jsonb,
  description     text,

  -- Provenance + approval lifecycle
  generated_by    text NOT NULL CHECK (generated_by IN (
    'congress', 'admin', 'heuristic'
  )),
  congress_run_id uuid REFERENCES congress_runs(id),
  team_focus_id   uuid REFERENCES team_focus(id),
  quarterly_goal_id uuid REFERENCES quarterly_goals(id),

  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN (
                    'proposed',  -- congress-generated, awaiting admin approve
                    'active',    -- approved + currently due
                    'completed', -- target hit
                    'expired',   -- due_date passed without hitting target
                    'rejected'   -- admin declined
                  )),

  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  approved_by_rep_id int REFERENCES sales_reps(id),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS missions_rep_due_idx
  ON missions (rep_id, due_date DESC, status);

CREATE INDEX IF NOT EXISTS missions_today_active_idx
  ON missions (due_date, status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS mission_progress (
  mission_id      uuid PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  count           int  NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Convenience view: live progress per active mission, one row.
-- /missions page reads this; admin tile reads this. Defensive
-- against direct mission_progress reads going stale (count is a
-- denormalized counter; the "true" count of e.g. emails sent today
-- is computable from emails table — but we keep this as the
-- approval-stamping affordance the UI uses).
CREATE OR REPLACE VIEW v_mission_today AS
  SELECT m.*,
         COALESCE(p.count, 0) AS progress_count,
         p.updated_at AS progress_updated_at
  FROM missions m
  LEFT JOIN mission_progress p ON p.mission_id = m.id
  WHERE m.due_date = CURRENT_DATE
    AND m.status IN ('active', 'completed');
