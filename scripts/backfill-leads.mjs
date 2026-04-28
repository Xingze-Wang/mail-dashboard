// Backfill missing school_tier / citation_count / h_index on
// pipeline_leads, then re-derive lead_tier on rows where the
// inputs changed.
//
// Three passes:
//   pass-1: school inference from author_email domain.
//   pass-2: Semantic Scholar lookup for h_index + citation_count.
//   pass-3: re-classify lead_tier where inputs changed.
//
// Idempotent. Run: node scripts/backfill-leads.mjs [--limit=N] [--skip-s2]

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const SUPABASE_URL = "https://erguqrisqtugfysofwdd.supabase.co";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const SKIP_S2 = args.includes("--skip-s2");

const SCHOOL_DATA = {};
try {
  const tsSrc = readFileSync("src/lib/scanner-config.ts", "utf8");
  const blockMatch = tsSrc.match(/SCHOOL_DATA[^=]*=\s*{([\s\S]*?)\n};/);
  if (blockMatch) {
    const lineRe = /"([^"]+)":\s*{\s*name:\s*"([^"]+)"\s*,\s*tier:\s*(\d+)\s*(?:,\s*count:\s*\d+)?\s*}/g;
    let m;
    while ((m = lineRe.exec(blockMatch[1])) !== null) {
      SCHOOL_DATA[m[1].toLowerCase()] = { name: m[2], tier: Number(m[3]) };
    }
  }
  console.log(`Loaded SCHOOL_DATA: ${Object.keys(SCHOOL_DATA).length} domains.`);
} catch (e) {
  console.warn("SCHOOL_DATA load failed:", e.message);
}

function inferSchool(email) {
  if (!email) return null;
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  if (SCHOOL_DATA[domain]) return SCHOOL_DATA[domain];
  const parts = domain.split(".");
  for (let i = 1; i < parts.length; i++) {
    const partial = parts.slice(i).join(".");
    if (SCHOOL_DATA[partial]) return SCHOOL_DATA[partial];
  }
  return null;
}

async function pass1School() {
  console.log("\n=== Pass 1: school_tier / school_name from author_email ===");
  const { data: leads, error } = await sb
    .from("pipeline_leads")
    .select("id, author_email, school_tier, school_name")
    .is("school_tier", null)
    .not("author_email", "is", null);
  if (error) { console.error("query failed:", error.message); return { changed: 0 }; }
  const subjects = (leads ?? []).slice(0, LIMIT);
  console.log(`  ${subjects.length} candidates with school_tier=null`);
  let changed = 0;
  for (const l of subjects) {
    const info = inferSchool(l.author_email);
    if (!info) continue;
    const updates = {};
    if (l.school_tier !== info.tier) updates.school_tier = info.tier;
    if (!l.school_name && info.name) updates.school_name = info.name;
    if (Object.keys(updates).length === 0) continue;
    const { error: uErr } = await sb.from("pipeline_leads").update(updates).eq("id", l.id);
    if (uErr) { console.warn(`  fail id=${l.id}: ${uErr.message}`); continue; }
    changed++;
  }
  console.log(`  filled school_tier / school_name on ${changed} rows`);
  return { changed };
}

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_DELAY_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fuzzyMatch(a, b) {
  const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return norm(a) === norm(b)
    || (norm(a).length > 4 && norm(b).includes(norm(a)))
    || (norm(b).length > 4 && norm(a).includes(norm(b)));
}

async function s2Paper(title, authorName) {
  if (!title || !authorName) return null;
  try {
    const url = `${S2_BASE}/paper/search?query=${encodeURIComponent(title.slice(0, 120))}&limit=3&fields=title,authors.name,authors.authorId`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    for (const paper of d.data ?? []) {
      const author = (paper.authors ?? []).find((a) => fuzzyMatch(a.name, authorName));
      if (author?.authorId) {
        await sleep(S2_DELAY_MS);
        const detail = await fetch(`${S2_BASE}/author/${author.authorId}?fields=hIndex,citationCount,paperCount,affiliations`);
        if (!detail.ok) return null;
        const ad = await detail.json();
        return { authorId: author.authorId, hIndex: ad.hIndex ?? null, citationCount: ad.citationCount ?? null, paperCount: ad.paperCount ?? null };
      }
    }
    return null;
  } catch { return null; }
}

async function s2Author(authorName) {
  if (!authorName) return null;
  try {
    const r = await fetch(`${S2_BASE}/author/search?query=${encodeURIComponent(authorName)}&limit=5&fields=name,hIndex,citationCount,paperCount,affiliations`);
    if (!r.ok) return null;
    const d = await r.json();
    let best = null;
    for (const a of d.data ?? []) {
      if (!fuzzyMatch(a.name, authorName)) continue;
      const c = { authorId: a.authorId, hIndex: a.hIndex ?? 0, citationCount: a.citationCount ?? 0, paperCount: a.paperCount ?? 0 };
      if (!best || c.hIndex > best.hIndex) best = c;
    }
    return best;
  } catch { return null; }
}

async function pass2S2() {
  console.log("\n=== Pass 2: h_index / citation_count from Semantic Scholar ===");
  if (SKIP_S2) { console.log("  --skip-s2 set"); return { changed: 0, missed: 0 }; }
  const { data: leads } = await sb
    .from("pipeline_leads")
    .select("id, title, author_name, h_index, citation_count, s2_author_id")
    .or("h_index.is.null,citation_count.is.null")
    .not("author_name", "is", null);
  const subjects = (leads ?? []).slice(0, LIMIT);
  console.log(`  ${subjects.length} candidates`);
  let changed = 0, missed = 0, errored = 0;
  for (let i = 0; i < subjects.length; i++) {
    const l = subjects[i];
    if (i > 0) await sleep(S2_DELAY_MS);
    const result = (await s2Paper(l.title, l.author_name)) || (await s2Author(l.author_name));
    if (!result) { missed++; continue; }
    const updates = {};
    if (l.h_index == null && result.hIndex != null) updates.h_index = result.hIndex;
    if (l.citation_count == null && result.citationCount != null) updates.citation_count = result.citationCount;
    if (l.s2_author_id == null && result.authorId) updates.s2_author_id = result.authorId;
    if (result.paperCount != null) updates.paper_count = result.paperCount;
    if (Object.keys(updates).length === 0) { missed++; continue; }
    const { error: uErr } = await sb.from("pipeline_leads").update(updates).eq("id", l.id);
    if (uErr) { console.warn(`  fail id=${l.id}: ${uErr.message}`); errored++; continue; }
    changed++;
    if (changed > 0 && changed % 25 === 0) {
      console.log(`  progress: ${changed} filled, ${missed} missed, ${errored} errored — ${i + 1}/${subjects.length}`);
    }
  }
  console.log(`  done: filled ${changed}, missed ${missed}, errored ${errored}`);
  return { changed, missed };
}

async function pass3ReClassify() {
  console.log("\n=== Pass 3: re-derive lead_tier ===");
  const { data: cfgRow } = await sb.from("system_config").select("value").eq("key", "active_assignment_config").maybeSingle();
  const cfg = cfgRow?.value?.strong_criteria ?? { min_citation: 1000, min_citation_unverified: 5000, max_school_tier: 2, min_local_score: 70 };
  const TIER_BONUS = { 1: 2000, 2: 1000, 3: 0 };

  function classify(lead) {
    const tier = lead.school_tier;
    const cite = lead.citation_count ?? 0;
    const score = lead.local_score ?? 0;
    const hasIndustry = Array.isArray(lead.industry_orgs) && lead.industry_orgs.length > 0;
    let schoolBonus = 0;
    if (tier != null && tier <= cfg.max_school_tier) schoolBonus = TIER_BONUS[tier] ?? 0;
    const scoreBonus = score >= cfg.min_local_score ? 500 : 0;
    const industryBonus = hasIndustry ? 2500 : 0;
    const effective = cite + schoolBonus + scoreBonus + industryBonus;
    if (effective > cfg.min_citation) return "strong";
    if (tier == null && cite > cfg.min_citation_unverified) return "strong";
    return "normal";
  }

  const { data: leads } = await sb.from("pipeline_leads").select("id, school_tier, citation_count, local_score, industry_orgs, lead_tier");
  let changed = 0, promoted = 0, demoted = 0;
  for (const l of leads ?? []) {
    const newTier = classify(l);
    if (newTier === l.lead_tier) continue;
    const { error } = await sb.from("pipeline_leads").update({ lead_tier: newTier }).eq("id", l.id);
    if (error) continue;
    changed++;
    if (newTier === "strong") promoted++; else demoted++;
  }
  console.log(`  re-classified ${changed} (${promoted} → strong, ${demoted} → normal)`);
  return { changed };
}

async function coverage() {
  const total = (await sb.from("pipeline_leads").select("*", { count: "exact", head: true })).count ?? 0;
  const sch = (await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).not("school_tier", "is", null)).count ?? 0;
  const cit = (await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).not("citation_count", "is", null)).count ?? 0;
  const h = (await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).not("h_index", "is", null)).count ?? 0;
  return {
    total,
    school_tier: `${sch}/${total} (${Math.round((100 * sch) / Math.max(total, 1))}%)`,
    citation_count: `${cit}/${total} (${Math.round((100 * cit) / Math.max(total, 1))}%)`,
    h_index: `${h}/${total} (${Math.round((100 * h) / Math.max(total, 1))}%)`,
  };
}

const before = await coverage();
console.log("Coverage before:", before);

const r1 = await pass1School();
const r2 = await pass2S2();
const r3 = await pass3ReClassify();

const after = await coverage();
console.log("\nCoverage after:", after);
console.log(`\nSummary: school +${r1.changed}, s2 +${r2.changed}, lead_tier reclassified ${r3.changed}.`);
