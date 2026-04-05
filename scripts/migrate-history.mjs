/**
 * migrate-history.mjs — One-time migration of local JSON files to Supabase
 *
 * Migrates:
 * 1. email_history.json (2917 contacts) → email_contact_history table
 * 2. processed_papers.json (16259 papers) → processed_papers table
 * 3. checkpoint.json → scanner_state table
 *
 * Usage:
 *   node scripts/migrate-history.mjs
 *
 * Prerequisites:
 *   Run the SQL below in Supabase SQL Editor first:
 *
 *   create table if not exists email_contact_history (
 *     email text primary key,
 *     paper_title text,
 *     subject text,
 *     contacted_at timestamptz not null,
 *     source text default 'python_script'
 *   );
 *
 *   create table if not exists processed_papers (
 *     arxiv_id text primary key,
 *     processed_at timestamptz not null default now()
 *   );
 *
 *   create table if not exists scanner_state (
 *     id text primary key default 'default',
 *     last_arxiv_id text,
 *     last_run timestamptz,
 *     updated_at timestamptz not null default now()
 *   );
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMAIL_DIR = resolve(__dirname, "../../Email");

// ── Supabase credentials (same as in import.mjs) ──
const supabase = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM"
);

// ── Helper: batch insert with progress ──
async function batchInsert(table, rows, batchSize = 500) {
  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict: Object.keys(batch[0])[0] });

    if (error) {
      console.error(`  ❌ Batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
      skipped += batch.length;
    } else {
      inserted += batch.length;
    }

    // Progress
    const pct = Math.round(((i + batch.length) / rows.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${inserted} inserted, ${skipped} errors)`);
  }

  console.log(); // newline after progress
  return { inserted, skipped };
}

// ── 1. Migrate email_history.json ──
async function migrateEmailHistory() {
  const file = resolve(EMAIL_DIR, "email_history.json");
  if (!existsSync(file)) {
    console.log("⏭️  email_history.json not found, skipping");
    return;
  }

  console.log("📧 Migrating email_history.json...");
  const data = JSON.parse(readFileSync(file, "utf-8"));
  const entries = Object.entries(data);
  console.log(`  Found ${entries.length} contacts`);

  const rows = entries.map(([email, info]) => ({
    email: email.toLowerCase(),
    paper_title: info.paper || null,
    subject: info.subject || null,
    contacted_at: info.date || new Date().toISOString(),
    source: "python_script",
  }));

  const { inserted, skipped } = await batchInsert("email_contact_history", rows);
  console.log(`  ✅ Done: ${inserted} inserted, ${skipped} errors\n`);
}

// ── 2. Migrate processed_papers.json ──
async function migrateProcessedPapers() {
  const file = resolve(EMAIL_DIR, "processed_papers.json");
  if (!existsSync(file)) {
    console.log("⏭️  processed_papers.json not found, skipping");
    return;
  }

  console.log("📄 Migrating processed_papers.json...");
  const data = JSON.parse(readFileSync(file, "utf-8"));
  console.log(`  Found ${data.length} processed papers`);

  const rows = data.map((arxivId) => ({
    arxiv_id: arxivId,
  }));

  const { inserted, skipped } = await batchInsert("processed_papers", rows);
  console.log(`  ✅ Done: ${inserted} inserted, ${skipped} errors\n`);
}

// ── 3. Migrate checkpoint.json ──
async function migrateCheckpoint() {
  const file = resolve(EMAIL_DIR, "checkpoint.json");
  if (!existsSync(file)) {
    console.log("⏭️  checkpoint.json not found, skipping");
    return;
  }

  console.log("📍 Migrating checkpoint.json...");
  const data = JSON.parse(readFileSync(file, "utf-8"));
  console.log(`  Last arxiv ID: ${data.last_arxiv_id}`);
  console.log(`  Last run: ${data.last_run}`);

  const { error } = await supabase.from("scanner_state").upsert({
    id: "default",
    last_arxiv_id: data.last_arxiv_id,
    last_run: data.last_run,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.log(`  ❌ Error: ${error.message}\n`);
  } else {
    console.log(`  ✅ Done\n`);
  }
}

// ── Run all ──
async function main() {
  console.log("=" .repeat(50));
  console.log("📦 Migrating local JSON files to Supabase");
  console.log("=" .repeat(50) + "\n");

  await migrateEmailHistory();
  await migrateProcessedPapers();
  await migrateCheckpoint();

  console.log("=" .repeat(50));
  console.log("🎉 Migration complete!");
  console.log("=" .repeat(50));
}

main().catch(console.error);
