// Local backfill: enrich existing persons rows for {homepage, twitter,
// hf, github}. Idempotent — skips signals already populated.
//
// Run: npx tsx scripts/backfill-person-enrichment.ts --limit=100
//
// Loads .env.local at startup so SUPABASE_SERVICE_KEY etc. resolve the
// same way as Next.js server code.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env.local into process.env (basic KEY=VALUE / KEY="VALUE").
const envPath = resolve("/Users/xingzewang/Desktop/mail/.env.local");
try {
  const env = readFileSync(envPath, "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch (e) {
  console.error(`[backfill] could not read ${envPath}: ${String(e)}`);
  process.exit(1);
}

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : 100;

async function main() {
  // Lazy-import the library AFTER env is set so its supabase singleton
  // picks up the keys.
  const { enrichPerson } = await import("../src/lib/person-enrichment.ts");
  const { supabase } = await import("../src/lib/db.ts");

  // Two-step prioritized backfill:
  //   (a) high-yield: persons whose linked lead has github.com or
  //       huggingface.co in the abstract (regex catches → ~16% of leads)
  //   (b) general: any person with a linked lead that has author_name
  //
  // (a) hits first because the cost-per-yield is much lower.
  const { data: yieldLeads, error: ylErr } = await supabase
    .from("pipeline_leads")
    .select("person_id, title, abstract, author_name")
    .not("person_id", "is", null)
    .not("author_name", "is", null)
    .or("abstract.ilike.%github.com/%,abstract.ilike.%huggingface.co/%,abstract.ilike.%project page%,abstract.ilike.%project website%")
    .order("created_at", { ascending: false })
    .limit(LIMIT * 3);
  if (ylErr) {
    console.error("yield-leads query failed:", ylErr.message);
    process.exit(1);
  }

  // Map person_id → first matching lead (so we pass the correct hint).
  const hintByPerson = new Map<string, { title: string; abstract: string; author_name: string }>();
  for (const l of yieldLeads ?? []) {
    const pid = l.person_id as string;
    if (!hintByPerson.has(pid)) {
      hintByPerson.set(pid, {
        title: (l.title as string) || "",
        abstract: (l.abstract as string) || "",
        author_name: (l.author_name as string) || "",
      });
    }
  }
  const yieldIds = [...hintByPerson.keys()];

  // Filter to those still missing homepage / twitter on persons.
  const { data: persons, error } = await supabase
    .from("persons")
    .select("id, homepage, twitter_handle, hf_users, github_users")
    .in("id", yieldIds.slice(0, LIMIT * 2))
    .or("homepage.is.null,twitter_handle.is.null")
    .limit(LIMIT);
  if (error) {
    console.error("persons query failed:", error.message);
    process.exit(1);
  }

  console.log(`Processing ${persons?.length ?? 0} persons (high-yield: lead has URL/project-page cue)...`);

  let added = 0;
  let missed = 0;
  let errored = 0;
  const signalTotals: Record<string, number> = { homepage: 0, twitter: 0, hf: 0, github: 0 };
  const t0 = Date.now();

  for (const [i, p] of (persons ?? []).entries()) {
    const hint = hintByPerson.get(p.id as string);
    const r = await enrichPerson({ person_id: p.id as string, hint });
    if (r.error) errored++;
    else if (r.signals_written > 0) added++;
    else missed++;
    for (const [k, v] of Object.entries(r.per_signal)) {
      if (v === "added") signalTotals[k]++;
    }
    if (i % 5 === 0 || i === (persons?.length ?? 0) - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${persons?.length}] added=${added} missed=${missed} errored=${errored} t=${elapsed}s`);
    }
  }

  console.log("\nSummary:");
  console.log(`  processed: ${persons?.length ?? 0}`);
  console.log(`  added (>=1 signal): ${added}`);
  console.log(`  missed (no signals): ${missed}`);
  console.log(`  errored: ${errored}`);
  console.log(`  per-signal additions: ${JSON.stringify(signalTotals)}`);
  console.log(`  total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
