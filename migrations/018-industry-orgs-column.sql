-- ═══════════════════════════════════════════════════════════════════
-- Migration 018: industry_orgs column on pipeline_leads
--
-- /api/pipeline/import populates an `industry_orgs` array (e.g.
-- ["OpenAI", "Anthropic"]) detected from S2 affiliations + ack mining,
-- and classifyLead() in lib/assignment.ts gives a +2500 citation-
-- equivalent bonus when it's non-empty. But no migration created the
-- column, so the write silently fails (supabase returns PGRST204) and
-- industry-affiliated researchers keep getting classified as 'normal'.
--
-- The /api/config/assignment POST re-classify now reads the column
-- so a re-run after seeding the column can correct historical rows.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table pipeline_leads
  add column if not exists industry_orgs text[];

create index if not exists idx_pipeline_leads_industry_orgs
  on pipeline_leads using gin (industry_orgs) where industry_orgs is not null;
