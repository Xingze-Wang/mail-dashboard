// Apply migrations/026-emails-actor-rep-id.sql via _exec_sql RPC.
// Idempotent — column already exists in prod (added out-of-band);
// this just formalizes it and runs the heuristic backfill.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/026-emails-actor-rep-id.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}
const { count } = await sb.from("emails").select("*", { count: "exact", head: true }).not("actor_rep_id", "is", null);
console.log(`OK. actor_rep_id now set on ${count} rows`);
