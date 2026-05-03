// Agent 10 — gh-repo slice runner.
// Mirrors strategyGhRepo in scripts/enrich-net.mjs but only over the
// (arxiv_id, github_repo) pairs in slice-10.json. Writes a JSONL summary
// line on completion.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BAD_EMAIL_DOMAINS = new Set([
  "adobe.com", "ams.org", "arxiv.org", "ctan.org", "openreview.net",
  "tex.stackexchange.com", "ieee.org", "acm.org",
]);
function isRealEmail(e) {
  const d = (e.split("@")[1] ?? "").toLowerCase();
  if (BAD_EMAIL_DOMAINS.has(d)) return false;
  if ((e.split("@")[0] ?? "").length < 2) return false;
  return true;
}

const SLICE_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-10.json";
const SUMMARY_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";

const slice = JSON.parse(readFileSync(SLICE_PATH, "utf8"));
const { agent, strategy, items } = slice;
console.log(`agent=${agent} strategy=${strategy} items=${items.length}`);

const start = Date.now();
const queue = items.slice();
const total = queue.length;
let scanned = 0;
let ownerEnriched = 0;
let ghLinked = 0;
let newPersons = 0;
let errors = 0;

// Authenticated GH calls if a token is available — bumps the rate limit
// from 60/hr to 5000/hr.
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const ghHeaders = GH_TOKEN
  ? { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" }
  : { Accept: "application/vnd.github+json" };

const CONC = 4;

async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    scanned++;
    const [owner, repo] = (p.github_repo ?? "").split("/");
    if (!owner || !repo) continue;
    try {
      // 1) owner profile
      const profRes = await fetch(`https://api.github.com/users/${owner}`, {
        signal: AbortSignal.timeout(10_000),
        headers: ghHeaders,
      });
      if (profRes.ok) {
        const prof = await profRes.json();
        const profEmail = prof.email?.toLowerCase();
        const profName = prof.name;
        if (profEmail && isRealEmail(profEmail)) {
          const { data: existing } = await sb
            .from("persons")
            .select("id, github_users, real_name")
            .contains("emails", [profEmail])
            .maybeSingle();
          if (existing) {
            const ghs = new Set(existing.github_users ?? []);
            if (!ghs.has(owner)) {
              ghs.add(owner);
              const { error: updErr } = await sb
                .from("persons")
                .update({
                  github_users: [...ghs],
                  real_name: existing.real_name ?? profName ?? null,
                })
                .eq("id", existing.id);
              if (updErr) errors++;
              else ghLinked++;
            }
          } else {
            const { error: insErr } = await sb.from("persons").insert({
              emails: [profEmail],
              github_users: [owner],
              real_name: profName,
              outreach_status: "new",
              source_events: [{
                kind: "github_owner",
                repo: p.github_repo,
                found_at: new Date().toISOString(),
              }],
            });
            if (insErr) errors++;
            else newPersons++;
          }
          ownerEnriched++;
        }
      } else if (profRes.status !== 404) {
        errors++;
      }

      // 2) commit emails
      const commitsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, "")}/commits?per_page=10`,
        { signal: AbortSignal.timeout(10_000), headers: ghHeaders },
      );
      if (commitsRes.ok) {
        const commits = await commitsRes.json();
        const commitEmails = new Set();
        for (const c of (Array.isArray(commits) ? commits : [])) {
          const e = c.commit?.author?.email?.toLowerCase();
          if (e && isRealEmail(e) && !e.includes("noreply.github.com")) {
            commitEmails.add(e);
          }
        }
        for (const ce of commitEmails) {
          const { data: dup } = await sb
            .from("persons")
            .select("id")
            .contains("emails", [ce])
            .maybeSingle();
          if (!dup) {
            const { error: insErr } = await sb.from("persons").insert({
              emails: [ce],
              source_events: [{
                kind: "github_commit",
                repo: p.github_repo,
                found_at: new Date().toISOString(),
              }],
            });
            if (insErr) errors++;
            else newPersons++;
          }
        }
      } else if (commitsRes.status !== 404 && commitsRes.status !== 409) {
        // 409 = empty repo — not an error
        errors++;
      }
    } catch {
      errors++;
    }
    if (scanned % 5 === 0) {
      process.stdout.write(
        `  ${scanned}/${total} (owner+=${ownerEnriched}, gh-link+=${ghLinked}, new=${newPersons}, err=${errors})\r`,
      );
    }
    await sleep(GH_TOKEN ? 200 : 600); // unauth = 60/hr ≈ 1 req/min; be polite
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - start;
const summary = {
  agent: String(agent),
  strategy,
  scanned,
  wins: ownerEnriched + ghLinked,
  errors,
  new_persons: newPersons,
  duration_ms,
};
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");
console.log(
  `done: scanned=${scanned} owner_enriched=${ownerEnriched} gh_linked=${ghLinked} new_persons=${newPersons} errors=${errors} duration_ms=${duration_ms}`,
);
