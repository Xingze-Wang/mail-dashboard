// Backfill pipeline_leads.embedding for existing rows.
//
// Pre-requisites:
//   1. pgvector extension enabled in Supabase dashboard
//   2. migrations/030-pgvector-leads.sql applied (scripts/apply-030.mjs)
//   3. MIRACLEPLUS_PROXY_KEY in env (read from .env.local)
//
// Cost: ~$0.01 per 1000 leads at openai text-embedding-3-small prices.
// Idempotent — only embeds rows where embedding IS NULL.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8");
const proxyKey = env.match(/^MIRACLEPLUS_PROXY_KEY=(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim();
if (!proxyKey) {
  console.error("MIRACLEPLUS_PROXY_KEY not in .env.local");
  process.exit(1);
}

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

async function embed(text) {
  const r = await fetch("https://openai-proxy.miracleplus.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${proxyKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
  const d = await r.json();
  return d.data[0].embedding;
}

async function fetchUnembedded(limit) {
  const { data, error } = await sb
    .from("pipeline_leads")
    .select("id, title, abstract")
    .is("embedding", null)
    .not("title", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

let total = 0;
const PAGE = 25;
while (true) {
  const rows = await fetchUnembedded(PAGE);
  if (rows.length === 0) break;
  for (const lead of rows) {
    const text = `${lead.title ?? ""}\n\n${lead.abstract ?? ""}`.trim();
    if (!text) continue;
    try {
      const v = await embed(text);
      const literal = `[${v.join(",")}]`;
      const { error } = await sb.from("pipeline_leads").update({ embedding: literal }).eq("id", lead.id);
      if (error) {
        console.error(`  fail id=${lead.id}: ${error.message}`);
        continue;
      }
      total++;
      if (total % 25 === 0) console.log(`  done ${total}`);
    } catch (e) {
      console.error(`  embed fail id=${lead.id}: ${e.message}`);
    }
  }
}
console.log(`Backfilled ${total} leads.`);
