// Smoke: lead-enrichment.ts on a real prod lead.
//
// What it does:
//   1. Pull a recent pipeline_leads row with s2_author_id IS NULL (i.e.
//      one that the import-time enrichment hasn't touched yet).
//   2. Call enrichLeadOnImport() against it (no DB write — just the
//      pure-function part).
//   3. Print the delta.
//   4. Assert the function returned without throwing.
//
// The success criterion is "did not throw". Even an obscure author can
// legitimately have S2 return null + repo extraction find nothing, so
// populated_fields can be empty — that's still a passing run.
//
// Optional second pass: --persist will call updateLeadWithDelta() so
// you can inspect the lead row after the smoke. Off by default to keep
// the smoke read-only.
//
// Usage:
//   node scripts/_smoke-enrich-lead.mjs              # read-only
//   node scripts/_smoke-enrich-lead.mjs --persist    # writes to DB
//   LEAD_ID=<uuid> node scripts/_smoke-enrich-lead.mjs  # specific lead

import { readFileSync } from "node:fs";
const envFile = readFileSync(
  new URL("../.env.local", import.meta.url).pathname,
  "utf8",
);
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing SUPABASE env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY). Check .env.local.",
  );
  process.exit(2);
}

const persist = process.argv.includes("--persist");
const targetLeadId = process.env.LEAD_ID || null;

async function q(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase ${r.status}: ${txt}`);
  }
  return r.json();
}

function ok(msg) {
  console.log("OK:", msg);
}
function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// 1. Pick a target lead.
let lead;
if (targetLeadId) {
  const rows = await q(
    `pipeline_leads?id=eq.${targetLeadId}&select=id,title,abstract,author_name,author_email,first_name,school_name,school_tier,matched_directions,s2_author_id,h_index,citation_count,paper_count,person_id,industry_orgs,arxiv_id`,
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    fail(`LEAD_ID=${targetLeadId} not found in pipeline_leads`);
  }
  lead = rows[0];
} else {
  // Newest first, unenriched, with usable identity.
  const rows = await q(
    `pipeline_leads?select=id,title,abstract,author_name,author_email,first_name,school_name,school_tier,matched_directions,s2_author_id,h_index,citation_count,paper_count,person_id,industry_orgs,arxiv_id&s2_author_id=is.null&author_name=not.is.null&author_email=not.is.null&order=created_at.desc&limit=5`,
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    console.warn(
      "WARN: no leads with s2_author_id IS NULL found — every lead is already enriched. Falling back to ANY recent lead.",
    );
    const fallback = await q(
      `pipeline_leads?select=id,title,abstract,author_name,author_email,first_name,school_name,school_tier,matched_directions,s2_author_id,h_index,citation_count,paper_count,person_id,industry_orgs,arxiv_id&author_name=not.is.null&order=created_at.desc&limit=1`,
    );
    if (!Array.isArray(fallback) || fallback.length === 0) {
      fail("no leads in pipeline_leads at all");
    }
    lead = fallback[0];
  } else {
    // Pick a random one of the 5 so re-runs hit different rows.
    lead = rows[Math.floor(Math.random() * rows.length)];
  }
}

ok(`picked lead ${lead.id.slice(0, 8)} (${lead.author_email}, "${(lead.title ?? "").slice(0, 60)}")`);
console.log("    existing:", {
  s2_author_id: lead.s2_author_id,
  h_index: lead.h_index,
  citation_count: lead.citation_count,
  person_id: lead.person_id ? lead.person_id.slice(0, 8) : null,
});

// 2. Import the lib (Node 22 native TS).
const { enrichLeadOnImport, updateLeadWithDelta } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/lead-enrichment.ts"
);

// 3. Run.
const t0 = Date.now();
let summary;
try {
  summary = await enrichLeadOnImport({
    lead_id: lead.id,
    title: lead.title ?? "",
    abstract: lead.abstract ?? null,
    author_name: lead.author_name ?? null,
    author_email: lead.author_email ?? "",
    first_name: lead.first_name ?? null,
    school_name: lead.school_name ?? null,
    school_tier: lead.school_tier ?? null,
    matched_directions: lead.matched_directions ?? null,
    arxiv_id: lead.arxiv_id ?? null,
    existing: {
      s2_author_id: lead.s2_author_id ?? null,
      h_index: lead.h_index ?? null,
      citation_count: lead.citation_count ?? null,
      paper_count: lead.paper_count ?? null,
      person_id: lead.person_id ?? null,
      industry_orgs: lead.industry_orgs ?? null,
    },
  });
} catch (err) {
  fail(`enrichLeadOnImport threw: ${err?.message ?? err}`);
}
const ms = Date.now() - t0;
ok(`enrichLeadOnImport returned in ${ms}ms`);

// 4. Print + assert.
console.log("    delta:", summary.delta);
console.log("    populated_fields:", summary.populated_fields);
if (Object.keys(summary.errors).length > 0) {
  console.log("    sub-step errors:", summary.errors);
}

// 5. Optional persist.
if (persist) {
  const r = await updateLeadWithDelta(lead.id, summary.delta);
  ok(`persist: wrote=${r.wrote} columns=${r.columns.join(",") || "(none)"}`);
}

// 6. Final assertion: function returned (we never got here otherwise),
//    delta exists, and timing is reasonable. populated_fields CAN be
//    empty for genuinely obscure authors.
if (!summary || typeof summary.delta !== "object") {
  fail("summary.delta is not an object");
}
if (ms > 20_000) {
  console.warn(`WARN: enrichment took ${ms}ms — exceeded 20s budget`);
}
if (summary.populated_fields.length === 0) {
  console.warn(
    "WARN: 0 fields populated. Could be legitimate (obscure author, no abstract) or an S2/person-resolver outage. Check sub-step errors above.",
  );
} else {
  ok(`enrichment populated ${summary.populated_fields.length} field(s): ${summary.populated_fields.join(", ")}`);
}

console.log("\nSMOKE PASSED");
