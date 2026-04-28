// Apply migration 030 (pgvector + embedding column) AND register the
// cosine-NN RPC the helper read tool calls.
//
// Pre-requisite: pgvector extension must already be enabled in
// Supabase dashboard (Database → Extensions → vector → enable).
// The migration's DO block raises a clean error if it isn't.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/030-pgvector-leads.sql", "utf8");
console.log("Applying migration 030...");
const { error: m1 } = await sb.rpc("_exec_sql", { sql_text: sql });
if (m1) {
  console.error("FAIL:", m1.message);
  console.error("Hint: enable the vector extension in Supabase dashboard first.");
  process.exit(1);
}
console.log("  OK: column + index created");

// Companion RPC the helper tool calls. Defined separately so admins
// can re-run apply-030 to refresh the function without altering the
// column.
const rpc = `
create or replace function find_similar_leads_by_embedding(ref_id text, k int)
returns table (
  lead_id text,
  title text,
  author_name text,
  distance double precision
)
language sql stable as $$
  select
    p.id::text as lead_id,
    p.title,
    p.author_name,
    (p.embedding <=> r.embedding)::double precision as distance
  from pipeline_leads p
  cross join (select embedding from pipeline_leads where id = ref_id and embedding is not null limit 1) r
  where p.id::text != ref_id
    and p.embedding is not null
  order by p.embedding <=> r.embedding
  limit k
$$;
`;
const { error: m2 } = await sb.rpc("_exec_sql", { sql_text: rpc });
if (m2) {
  console.error("RPC create failed:", m2.message);
  process.exit(1);
}
console.log("  OK: find_similar_leads_by_embedding RPC registered");

console.log("\nNext step: node scripts/backfill-embeddings.mjs");
