-- migrations/057-onboarded-at-default.sql
--
-- 1. SCHEMA CHANGE
-- Adds DEFAULT now() to sales_reps.onboarded_at. Migration 056 added the
-- column without a default (relying on a one-shot UPDATE backfill of
-- existing rows). New INSERTs that don't set onboarded_at explicitly
-- (e.g. /api/migrate/add-ethan, the legacy seed route) would land with
-- NULL, which getCapabilities() now treats as 0 tenure days — usable
-- but suboptimal (a brand-new rep with 0 sends and NULL onboarded_at
-- looks identical to one onboarded 30 days ago who hasn't sent yet).
-- DEFAULT now() means INSERTs that omit it pick up the row's actual
-- creation time.
--
-- 2. WHO WRITES THIS?
-- - sales_reps.onboarded_at: now defaults to now() on INSERT. Explicit
--   sets in src/lib/onboarding.ts:provisionRep still take precedence.
--
-- 3. WHO READS THIS?
-- - src/lib/trust-level.ts:getCapabilities — reads onboarded_at to
--   compute tenureDays. Already null-safe + NaN-safe after the audit
--   fixes. This default just gives us a more meaningful value.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — migration 056 already backfilled all existing
-- rows with onboarded_at = created_at. This migration only affects
-- FUTURE INSERTs. ALTER COLUMN ... SET DEFAULT does not touch existing
-- rows.

ALTER TABLE sales_reps
  ALTER COLUMN onboarded_at SET DEFAULT now();
