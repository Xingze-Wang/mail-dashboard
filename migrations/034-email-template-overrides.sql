-- migrations/034-email-template-overrides.sql
--
-- 1. SCHEMA CHANGE
-- New table email_template_overrides: segment-conditional variants
-- of any email_templates slot. A template's effective slot value =
-- first matching override (by created_at) OR the default from the
-- email_templates row.
--
-- Slot-name values are exactly the email_templates column names
-- (subject_format, greeting_format, rep_intro_format,
-- school_pitch_format, cta_signoff_format, intro_prompt) — kept loose
-- as text so future slots don't require an enum bump.
--
-- Conditions live in `when` (jsonb). Recognized keys (all optional;
-- AND-ed when present): geo ∈ {"cn","edu","other"}, school_tier
-- (number), lead_tier (string). Unknown keys are ignored.
--
-- 2. WHO WRITES THIS?
-- src/app/api/email-templates/overrides/route.ts (POST/DELETE) — admin
-- creates/removes via the Voice Templates UI (Templates #3).
--
-- 3. WHO READS THIS?
-- src/lib/template-assembler.ts pickSlot() — at draft-render time,
-- looks up overrides for each slot, picks the first matching `when`.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new table, no old rows. Existing templates
-- without any overrides keep using the row's default value (the
-- existing format columns).
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

create table if not exists email_template_overrides (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references email_templates(id) on delete cascade,
  slot_name    text not null,
  -- jsonb of segment conditions; e.g. {"geo":"cn","school_tier":1}
  -- Empty object {} means "always match" — meaningless in practice
  -- but allowed.
  "when"       jsonb not null default '{}'::jsonb,
  value        text not null,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_email_template_overrides_template
  on email_template_overrides (template_id, slot_name);

notify pgrst, 'reload schema';
