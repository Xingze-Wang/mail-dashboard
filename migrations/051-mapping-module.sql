-- migrations/051-mapping-module.sql
-- 1. SCHEMA CHANGE
-- The "mapping" team is a different role from "sales": they build
-- vertical-specific targets (e.g. "MIT quantum physics postdocs"),
-- evolve the email template that goes to that vertical, and approve
-- every draft before it ships.
--
-- Three tables:
--   mapping_targets  — one row per target a mapping person owns
--   mapping_drafts   — drafts pending mapping-person approval
--   mapping_evolutions — log of template/strategy changes congress proposes
--
-- We piggyback on sales_reps (role = 'mapping') rather than a parallel
-- people table — keeps inbox + auth flows the same as sales reps.
--
-- 2. WHO WRITES
-- - mapping_targets: mapping person via lark bot interview (api/mapping/target)
-- - mapping_drafts: draft generator (api/mapping/draft) when bot writes a candidate
-- - mapping_evolutions: congress sub-loop when target/template needs revising
--
-- 3. WHO READS
-- - lark bot: get_my_targets / get_pending_drafts read-tools
-- - /mapping mailbox UI (a stripped /pipeline twin for mapping people)
-- - congress mapping-loop runner

create table if not exists mapping_targets (
  id uuid primary key default gen_random_uuid(),
  -- Owner — the mapping person who built this target
  owner_rep_id integer not null references sales_reps(id) on delete cascade,
  -- Short human label e.g. "MIT quantum physics postdocs"
  label text not null,
  -- The structured target spec — vertical, school filters, topic
  -- keywords, h-index range, geo, anything the bot interview captured.
  -- Free-form jsonb so we can evolve the schema without migration.
  spec jsonb not null default '{}',
  -- The mapping person's current best template for this target.
  -- Two columns: a "canonical" version they signed off on + a
  -- "candidate" version congress is currently testing.
  canonical_template_html text,
  candidate_template_html text,
  -- Whether the candidate template is currently being A/B'd vs canonical
  -- on a slice of leads.
  candidate_active boolean not null default false,
  -- Sample size + start time of the current candidate test
  candidate_sample_target integer,
  candidate_started_at timestamptz,
  -- Free-form notes / brand guidelines this target inherited (don't-do list)
  guidelines text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists mapping_targets_owner on mapping_targets(owner_rep_id, active);

-- Drafts: every email the bot writes for a target ends up here as
-- pending. Mapping person approves → moves to pipeline_leads.draft_html
-- and the lead is queued for send.
create table if not exists mapping_drafts (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references mapping_targets(id) on delete cascade,
  -- The lead this draft is for. Soft FK at the application layer
  -- because pipeline_leads.id is TEXT in this schema (legacy), and the
  -- ON DELETE behavior we want is "leave drafts orphaned for audit"
  -- rather than auto-cascade.
  lead_id text not null,
  -- The draft itself.
  subject text not null,
  body_html text not null,
  -- Why the bot picked this lead for this target — explanation surfaces
  -- in the mapping person's mailbox so they can sanity-check.
  match_reason text,
  -- "pending" | "approved" | "rejected" | "edited_and_approved"
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'edited_and_approved')),
  -- When the mapping person decided
  decided_at timestamptz,
  decided_by integer references sales_reps(id) on delete set null,
  -- If they edited it, what's the final version
  edited_subject text,
  edited_body_html text,
  -- Reject reason if rejected
  reject_reason text,
  created_at timestamptz not null default now()
);

create index if not exists mapping_drafts_target_state on mapping_drafts(target_id, state, created_at desc);
create index if not exists mapping_drafts_pending on mapping_drafts(state, created_at) where state = 'pending';

-- Evolutions: every time congress (or the bot itself) revises the
-- find-people strategy or the template, we log the change so we can
-- replay the timeline.
create table if not exists mapping_evolutions (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references mapping_targets(id) on delete cascade,
  -- "spec_revision" | "template_revision" | "guidelines_revision" | "strategy_note"
  kind text not null,
  -- What changed — diff or full new value
  diff jsonb not null default '{}',
  -- Who proposed this change — congress meeting, bot, or mapping person
  proposed_by text not null check (proposed_by in ('congress', 'bot', 'human')),
  -- Free-form rationale
  rationale text not null default '',
  -- Outcome metric collected after the change went live, if any
  outcome jsonb,
  created_at timestamptz not null default now()
);

create index if not exists mapping_evolutions_target_time on mapping_evolutions(target_id, created_at desc);

-- Add 'mapping' to the role check on sales_reps if there's one.
-- (sales_reps.role is currently text without check; nothing to alter.)
