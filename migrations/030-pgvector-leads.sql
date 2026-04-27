-- migrations/030-pgvector-leads.sql
--
-- ⚠ MANUAL PRE-STEP REQUIRED ⚠
-- The `vector` extension must be enabled in Supabase dashboard
-- (Database → Extensions → search "vector" → enable). Service-role
-- API key cannot create extensions; this is a one-time admin click.
-- After enabling, apply this migration via scripts/apply-030.mjs.
--
-- 1. SCHEMA CHANGE
-- Adds pipeline_leads.embedding (vector(1536)) — stores OpenAI
-- text-embedding-3-small representations of (title || abstract).
-- Plus an IVFFlat index for cosine similarity search.
--
-- 2. WHO WRITES THIS?
-- (a) src/lib/embeddings.ts → on-demand backfill via
--     scripts/backfill-embeddings.mjs (one-shot for existing rows)
-- (b) src/app/api/pipeline/scan/route.ts will write the embedding at
--     lead-insert time once the column exists (added in this PR).
--
-- 3. WHO READS THIS?
-- (a) Helper read tool find_similar_leads(reference_lead_id, n) at
--     src/lib/helper-read-tools.ts — cosine NN search
-- (b) Future: scan-time secondary signal (Dream #8) — sort new leads
--     by similarity to past wechat-converted leads. Stub for now.
--
-- 4. BACKFILL FOR OLD ROWS
-- (b) backfill route scripts/backfill-embeddings.mjs — paginates
--     pipeline_leads, embeds (title || abstract), writes the column.
--     Costs ~$0.01 per 1000 leads at openai prices via the proxy.
--     Run once after migration applies.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

-- The vector type only exists if the extension is enabled. Wrapping
-- in DO block so a fresh setup that forgot the manual step gets a
-- clean error message instead of a cryptic "type does not exist".
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise exception 'pgvector extension not enabled. Enable in Supabase dashboard: Database → Extensions → vector → enable. Then re-run this migration.';
  end if;
end $$;

alter table pipeline_leads
  add column if not exists embedding vector(1536);

-- IVFFlat with lists=100 is the safe default for tables in the 1k-10k
-- range. Promote to higher when leads grow past ~50k.
create index if not exists idx_pipeline_leads_embedding
  on pipeline_leads using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

notify pgrst, 'reload schema';
