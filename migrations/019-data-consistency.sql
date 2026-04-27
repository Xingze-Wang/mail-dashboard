-- Migration 019: close the data-inconsistency gaps flagged in the
-- 2026-04-24 ultrareview. Safe to re-run — every statement is guarded.
--
-- Covers:
--   D5  emails.actor_rep_id: attribution = who-did-the-action vs ownership = who-owns-the-lead
--   D7  lead_corrections.lead_id uuid → text  (type mismatch against pipeline_leads.id)
--   D8  missing FKs on emails.rep_id, prompt_drift_patterns.rep_id, lead_corrections.rep_id
--   D10 backfill: industry_orgs NULL → '{}'::text[] and SET DEFAULT
--   D12 persons FK ON DELETE SET NULL (was NO ACTION — makes persons impossible to clean up)
--   D15 composite index on pipeline_leads(assigned_rep_id, status)
--   D16 future-proof: migration 011 should NOT overwrite UI-edited global template
--        (noted here; the file-level fix is in migrations/011-seed-global-email-template.sql)
--
-- Run in Supabase SQL editor. Order matters: D7 first because D8 depends
-- on consistent types.

BEGIN;

-- ── D5: emails.actor_rep_id (attribution vs ownership) ──────────────────
-- emails.rep_id is the OWNER (mirror of lead's assigned_rep_id). When
-- admin/senior sends on behalf of another rep, rep_id = lead owner but
-- actor_rep_id = whoever pressed send. Bounce / reply attribution math
-- can now credit the right rep. Old rows stay NULL (attribution
-- genuinely unknown) and old queries ignore the column.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='emails') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='emails' AND column_name='actor_rep_id'
    ) THEN
      ALTER TABLE emails ADD COLUMN actor_rep_id integer;
      ALTER TABLE emails
        ADD CONSTRAINT emails_actor_rep_id_fkey
        FOREIGN KEY (actor_rep_id) REFERENCES sales_reps(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_emails_actor_rep_id
        ON emails (actor_rep_id) WHERE actor_rep_id IS NOT NULL;
    END IF;
  END IF;
END $$;

-- ── D7: lead_corrections.lead_id uuid → text ────────────────────────────
-- pipeline_leads.id is text (gen_random_uuid()::text). Having lead_id
-- as uuid in lead_corrections made it literally impossible to add the FK.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_corrections'
      AND column_name = 'lead_id'
      AND data_type = 'uuid'
  ) THEN
    -- Convert uuid column to text. Existing rows survive because uuid::text is lossless.
    ALTER TABLE lead_corrections ALTER COLUMN lead_id TYPE text USING lead_id::text;
  END IF;
END $$;

-- Drop stale FK if one exists under the old type so the new one can be added cleanly.
DO $$
DECLARE fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'lead_corrections'::regclass
    AND contype = 'f'
    AND conname LIKE '%lead_id%';
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lead_corrections DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

-- Before adding the FK, null out any lead_id values that don't match a
-- live pipeline_leads.id. Without this, the ALTER fails if any orphans
-- exist — aborting the whole migration. Orphaned lead_ids are also
-- useless (the lead is gone), so nulling them loses no real information.
-- lead_id is already nullable in 008's CREATE TABLE.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='lead_corrections' AND column_name='lead_id'
  ) THEN
    UPDATE lead_corrections lc
    SET lead_id = NULL
    WHERE lead_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pipeline_leads pl WHERE pl.id = lc.lead_id);
  END IF;
END $$;

-- Add the FK — now that types match and orphans are cleaned.
-- ON DELETE SET NULL (not CASCADE) so deleting a lead preserves the
-- correction audit log with lead_id=NULL. CASCADE would wipe the
-- learning signal, which defeats the point of having the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'lead_corrections'::regclass
      AND contype = 'f'
      AND conname = 'lead_corrections_lead_id_fkey'
  ) THEN
    ALTER TABLE lead_corrections
      ADD CONSTRAINT lead_corrections_lead_id_fkey
      FOREIGN KEY (lead_id) REFERENCES pipeline_leads(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── D8: missing FKs on rep_id columns ───────────────────────────────────
-- Migration 013 did this for helper_* tables but skipped these four.
-- Before adding each FK, null out any rep_id value that doesn't match a
-- live sales_reps row — without this, orphans abort the migration.
-- rep_id is already nullable on all four tables (see the respective
-- CREATE TABLE blocks).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='emails' AND column_name='rep_id')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'emails'::regclass AND conname = 'emails_rep_id_fkey'
     ) THEN
    UPDATE emails e SET rep_id = NULL
     WHERE rep_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sales_reps r WHERE r.id = e.rep_id);
    ALTER TABLE emails
      ADD CONSTRAINT emails_rep_id_fkey
      FOREIGN KEY (rep_id) REFERENCES sales_reps(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inbound_emails' AND column_name='rep_id')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'inbound_emails'::regclass AND conname = 'inbound_emails_rep_id_fkey'
     ) THEN
    UPDATE inbound_emails e SET rep_id = NULL
     WHERE rep_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sales_reps r WHERE r.id = e.rep_id);
    ALTER TABLE inbound_emails
      ADD CONSTRAINT inbound_emails_rep_id_fkey
      FOREIGN KEY (rep_id) REFERENCES sales_reps(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompt_drift_patterns' AND column_name='rep_id')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'prompt_drift_patterns'::regclass AND conname = 'prompt_drift_patterns_rep_id_fkey'
     ) THEN
    UPDATE prompt_drift_patterns p SET rep_id = NULL
     WHERE rep_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sales_reps r WHERE r.id = p.rep_id);
    ALTER TABLE prompt_drift_patterns
      ADD CONSTRAINT prompt_drift_patterns_rep_id_fkey
      FOREIGN KEY (rep_id) REFERENCES sales_reps(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lead_corrections' AND column_name='rep_id')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'lead_corrections'::regclass AND conname = 'lead_corrections_rep_id_fkey'
     ) THEN
    UPDATE lead_corrections c SET rep_id = NULL
     WHERE rep_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sales_reps r WHERE r.id = c.rep_id);
    ALTER TABLE lead_corrections
      ADD CONSTRAINT lead_corrections_rep_id_fkey
      FOREIGN KEY (rep_id) REFERENCES sales_reps(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── D10: industry_orgs null → empty array + default ─────────────────────
-- Added in migration 018 without a default. Pre-018 rows remained NULL,
-- never gaining the +2500 industry bonus even when they should have.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pipeline_leads' AND column_name='industry_orgs') THEN
    UPDATE pipeline_leads SET industry_orgs = '{}'::text[] WHERE industry_orgs IS NULL;
    ALTER TABLE pipeline_leads ALTER COLUMN industry_orgs SET DEFAULT '{}'::text[];
  END IF;
END $$;

-- ── D12: persons FKs ON DELETE SET NULL ─────────────────────────────────
-- Default is NO ACTION — you can't delete a person without manually
-- unlinking every reference. Switch to SET NULL to preserve historical
-- leads while allowing persons cleanup.

DO $$
DECLARE fk_name text;
BEGIN
  -- Only proceed if both tables exist. persons may be absent in some
  -- dev DBs where migration 001 never ran cleanly.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='persons') THEN RETURN; END IF;

  SELECT conname INTO fk_name FROM pg_constraint
    WHERE conrelid = 'pipeline_leads'::regclass AND contype = 'f' AND conname LIKE '%person_id%';
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pipeline_leads DROP CONSTRAINT %I', fk_name);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pipeline_leads' AND column_name='person_id') THEN
    -- Clean orphans so the FK add doesn't abort.
    UPDATE pipeline_leads l SET person_id = NULL
      WHERE person_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM persons p WHERE p.id = l.person_id);
    ALTER TABLE pipeline_leads
      ADD CONSTRAINT pipeline_leads_person_id_fkey
      FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE fk_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='persons') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='paper_authors') THEN RETURN; END IF;

  SELECT conname INTO fk_name FROM pg_constraint
    WHERE conrelid = 'paper_authors'::regclass AND contype = 'f' AND conname LIKE '%person_id%';
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE paper_authors DROP CONSTRAINT %I', fk_name);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='paper_authors' AND column_name='person_id') THEN
    UPDATE paper_authors a SET person_id = NULL
      WHERE person_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM persons p WHERE p.id = a.person_id);
    ALTER TABLE paper_authors
      ADD CONSTRAINT paper_authors_person_id_fkey
      FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE fk_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='persons') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='email_contact_history') THEN RETURN; END IF;

  SELECT conname INTO fk_name FROM pg_constraint
    WHERE conrelid = 'email_contact_history'::regclass AND contype = 'f' AND conname LIKE '%person_id%';
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE email_contact_history DROP CONSTRAINT %I', fk_name);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='email_contact_history' AND column_name='person_id') THEN
    UPDATE email_contact_history h SET person_id = NULL
      WHERE person_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM persons p WHERE p.id = h.person_id);
    ALTER TABLE email_contact_history
      ADD CONSTRAINT email_contact_history_person_id_fkey
      FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── D15: composite indexes for the most-queried predicates ─────────────
-- Every per-rep metric page does .eq('assigned_rep_id', ...).eq('status', ...)
-- — no covering index today → seq scan on pipeline_leads.

CREATE INDEX IF NOT EXISTS idx_pipeline_leads_rep_status
  ON pipeline_leads (assigned_rep_id, status);

CREATE INDEX IF NOT EXISTS idx_pipeline_leads_rep_sent_at
  ON pipeline_leads (assigned_rep_id, sent_at DESC);

COMMIT;
