-- migrations/039-congress-tables.sql
--
-- 1. SCHEMA CHANGE
-- Four new tables for the multi-loop congress architecture (see
-- docs/CONGRESS_ARCHITECTURE.md). Each loop produces evidence for the
-- next loop up; without these tables the loops are isolated cron jobs.
--
--   tactical_proposals    — Loop 2 weekly outputs, graded by Loop 3
--   strategic_directives  — Loop 3 monthly outputs, constrain Loop 2
--   strategic_decisions   — Loop 3 audit trail (different from
--                           directives: a decision is the deliberation
--                           record; a directive is the active rule)
--   incident_lessons      — Loop 4 postmortem outputs, included in
--                           every loop's prompt until resolved_at
--
-- 2. WHO WRITES THIS?
-- scripts/congress-{weekly,monthly,postmortem}.mjs — runners that
-- orchestrate the persona debates and persist outputs. The Lark
-- handler in src/lib/lark-agent.ts also writes ship_decision when
-- admin clicks Approve/Reject on the proposal card.
--
-- 3. WHO READS THIS?
-- - Loop 2 reads strategic_directives + incident_lessons (constraints)
-- - Loop 3 reads tactical_proposals (Historian grades them)
-- - Loop 4 reads everything (forensic timeline)
-- - All loops include incident_lessons WHERE resolved_at IS NULL in
--   their system prompts
--
-- 4. BACKFILL
-- (d) not applicable — new tables, history starts now.

-- ── Loop 2: tactical_proposals ─────────────────────────────────────────
create table if not exists tactical_proposals (
  id              uuid primary key default gen_random_uuid(),
  proposed_at     timestamptz not null default now(),
  -- One-line summary the Synthesizer produces. Goes on the Lark card.
  title           text not null,
  -- Full deliberation: persona-by-persona transcript + final spec.
  -- JSON shape: { personas: { data_analyst: "...", copywriter: "...",
  --   academic_proxy: "...", sales_director: "...", adversary: "...",
  --   synthesizer_final: "..." }, change_spec: {...}, evidence: {...} }
  deliberation    jsonb not null,
  -- The actual change to apply. Free-form; could be a SQL diff, a
  -- template patch, a routing rule change. The Synthesizer writes this.
  change_spec     jsonb not null,
  -- Quantifiable forward-looking commitments. Loop 3 Historian grades
  -- against actual_lift after evaluation_due_at.
  expected_lift   jsonb,                    -- e.g. {"metric":"open_rate","delta_pp":2.0}
  weeks_to_evaluate integer not null default 4,
  -- Computed on insert/update via trigger below (Postgres rejects this
  -- as a GENERATED column because interval cast isn't immutable).
  evaluation_due_at timestamptz,
  -- Admin gate
  ship_decision   text not null default 'pending'
                  check (ship_decision in ('pending','approved','rejected','superseded')),
  decided_at      timestamptz,
  decided_by      text,
  shipped_at      timestamptz,              -- set when change_spec actually gets applied
  -- Loop 3 grading
  graded_at       timestamptz,
  actual_lift     jsonb,                    -- mirrors expected_lift shape
  grade           text check (grade in ('hit','partial','miss','inconclusive'))
);

create or replace function tactical_set_due_at() returns trigger as $$
begin
  new.evaluation_due_at := new.proposed_at + (new.weeks_to_evaluate || ' weeks')::interval;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tactical_due_at on tactical_proposals;
create trigger trg_tactical_due_at
  before insert or update of proposed_at, weeks_to_evaluate
  on tactical_proposals
  for each row execute function tactical_set_due_at();

create index if not exists idx_tac_decision on tactical_proposals (ship_decision, proposed_at desc);
create index if not exists idx_tac_due_for_grading on tactical_proposals (evaluation_due_at)
  where ship_decision = 'approved' AND graded_at IS NULL;

-- ── Loop 3: strategic_directives ───────────────────────────────────────
-- An active rule that constrains Loop 2's tactical decisions. Distinct
-- from `strategic_decisions` (the audit trail of how this directive
-- was decided). Loop 2 reads only directives with active=true.
create table if not exists strategic_directives (
  id              uuid primary key default gen_random_uuid(),
  active          boolean not null default true,
  effective_from  timestamptz not null default now(),
  effective_until timestamptz,                -- NULL = indefinite
  body            text not null,              -- short directive text injected into Loop 2 prompt
  source_decision_id uuid,                    -- FK to strategic_decisions; set if this came from a Loop 3 deliberation
  notes           text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_directives_active on strategic_directives (active, effective_from desc);

-- ── Loop 3: strategic_decisions (audit trail) ──────────────────────────
create table if not exists strategic_decisions (
  id              uuid primary key default gen_random_uuid(),
  decided_at      timestamptz not null default now(),
  title           text not null,
  -- Same shape as tactical_proposals.deliberation but with the strategic
  -- roster: { personas: { historian, funnel_economist, constituent_advocate,
  -- adversary, synthesizer_final } }
  deliberation    jsonb not null,
  -- Decision can be: approved (becomes a directive), rejected, deferred
  outcome         text not null check (outcome in ('approved','rejected','deferred')),
  decided_by      text,
  -- If outcome=approved, the directive row that was created
  resulting_directive_id uuid references strategic_directives(id) on delete set null
);

alter table strategic_directives
  add constraint fk_directive_decision
  foreign key (source_decision_id) references strategic_decisions(id) on delete set null;

create index if not exists idx_strategic_decisions_at on strategic_decisions (decided_at desc);

-- ── Loop 4: incident_lessons ───────────────────────────────────────────
create table if not exists incident_lessons (
  id              uuid primary key default gen_random_uuid(),
  detected_at     timestamptz not null default now(),
  trigger_kind    text not null,              -- 'overall_conversion_drop' | 'rep_2sigma' | 'direction_collapse' | 'manual'
  trigger_evidence jsonb not null,            -- the metric snapshot that fired it
  -- Same persona-debate JSON: { personas: { historian, adversary,
  -- causal_investigator, synthesizer_final } }
  deliberation    jsonb not null,
  -- The narrative output. This becomes standing context for other loops.
  narrative       text not null,
  -- When the underlying issue is fixed; while NULL the lesson is
  -- included in every loop's system prompt.
  resolved_at     timestamptz,
  resolved_by     text,
  resolved_notes  text
);
create index if not exists idx_incident_unresolved on incident_lessons (detected_at desc) where resolved_at IS NULL;

notify pgrst, 'reload schema';
