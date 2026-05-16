-- migrations/099-miracleplus-contacts-mirror.sql
--
-- 1. SCHEMA CHANGE
-- New table `miracleplus_contacts` — local mirror of rows from the
-- MiraclePlus CRM's /open_api/v1/contacts/search endpoint. One row per
-- MP contact id. We keep the narrow set of fields the pipeline reads
-- as first-class columns + the full JSON envelope on `raw` for
-- forensics / future field additions without a schema change.
--
-- Columns:
--   mp_id                 bigint PK — MP's contact id (stable across calls)
--   email                 text     — as returned by MP. MAY BE MASKED to
--                                    "******" in staging; will be real
--                                    in prod.
--   email_canonical       text     — lowercased + trimmed, for joining
--                                    against emails.to / pipeline_leads.
--                                    author_email. NULL if we have no
--                                    usable email (masked, or absent).
--   name, phone           text     — names are real in staging; phones
--                                    are partially masked ("***5832").
--   application_progress  text     — THE conversion signal. NULL = no
--                                    application of record. Non-NULL
--                                    like "25春季创业营, Submitted".
--   application_stage     text     — richer than progress alone:
--                                    "Submitted" / "Interview" / etc.
--   applications_number   int      — count of applications.
--   submitted_at          date     — when (most-recent) submitted.
--   created_application_at date    — when first application kicked off.
--   project, s_product, s_channel, utm_source — attribution fields,
--                                    nullable.
--   raw                   jsonb    — the full MP contact envelope so we
--                                    can recover any field later
--                                    without re-fetching.
--   first_seen_at         timestamptz NOT NULL — when our sync first
--                                    saw this contact id.
--   last_seen_at          timestamptz NOT NULL — bumped on every sync
--                                    upsert. Useful to know "is this
--                                    contact still in MP's CRM" — if
--                                    last_seen lags by weeks the
--                                    contact may have been deleted.
--
-- Indexes:
--   miracleplus_contacts_email_idx — on email_canonical, for the
--     primary "did this person we emailed register / apply?" join.
--   miracleplus_contacts_submitted_idx — partial WHERE submitted_at IS
--     NOT NULL, for the conversion-matrix count.
--
-- 2. WHO WRITES?
-- src/lib/miracleplus-sync.ts:syncContactByEmail — called by
--   (a) /api/cron/sync-miracleplus-contacts (daily at 13:00 Beijing)
--   (b) scripts/_smoke-mp-conversion.mjs (one-shot smoke)
--   (c) future: on-demand from /pipeline UI when a rep wants to
--       check "did this person submit yet".
--
-- 3. WHO READS?
-- src/lib/canonical-counts.ts:getMpConversionMatrix — the 2x2 matrix
--   (registered / submitted vs wechat-added) that's the pipeline's
--   ground-truth conversion view. Surfaced to Leon via the
--   get_mp_conversions read tool, and (future) to /admin/conversions.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — this is a new table. Old rows from MP land
--     through the sync job's natural 7-day overlap window. We do NOT
--     do a one-shot historical pull because we only care about
--     contacts who match emails our reps recently sent — anything
--     older won't be referenced by the conversion-matrix join.

CREATE TABLE IF NOT EXISTS miracleplus_contacts (
  mp_id                  bigint PRIMARY KEY,
  email                  text,
  email_canonical        text,
  name                   text,
  phone                  text,
  application_progress   text,
  application_stage      text,
  applications_number    int,
  submitted_at           date,
  created_application_at date,
  project                text,
  s_product              text,
  s_channel              text,
  utm_source             text,
  raw                    jsonb,
  first_seen_at          timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS miracleplus_contacts_email_idx
  ON miracleplus_contacts (email_canonical);

CREATE INDEX IF NOT EXISTS miracleplus_contacts_submitted_idx
  ON miracleplus_contacts (submitted_at)
  WHERE submitted_at IS NOT NULL;
