// Agent 11 — gh-repo enrichment for slice-11 only.
// Mirrors strategyGhRepo in scripts/enrich-net.mjs but iterates the
// pre-sliced (arxiv_id, github_repo) list rather than re-querying every
// paper with a github_repo. Uses `gh auth token` (when set in env as
// GITHUB_TOKEN) to lift the GitHub API rate limit from 60/hr to 5000/hr.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";

const SLICE_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-11.json";
const SUMMARY_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";

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

const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const ghHeaders = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "qiji-enrich-bg-agent-11",
  ...(GH_TOKEN ? { "Authorization": `Bearer ${GH_TOKEN}` } : {}),
};

const slice = JSON.parse(readFileSync(SLICE_PATH, "utf8"));
const items = slice.items;
const start = Date.now();
console.log(`agent ${slice.agent} (gh-repo): ${items.length} items, auth=${GH_TOKEN ? "yes" : "no"}`);

const queue = [...items];
let processed = 0;
let ownerEnriched = 0;
let ghLinked = 0;
let newPersons = 0;
let errors = 0;
const CONC = 4;

async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    processed++;
    const repoStr = (p.github_repo || "").replace(/\.git$/i, "");
    const [owner, repo] = repoStr.split("/");
    if (!owner || !repo) continue;
    try {
      const profRes = await fetch(`https://api.github.com/users/${owner}`, {
        headers: ghHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      if (profRes.status === 403 || profRes.status === 429) {
        errors++;
        // Rate-limited: bail this iteration politely
        await sleep(2000);
        continue;
      }
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
              await sb.from("persons").update({
                github_users: [...ghs],
                real_name: existing.real_name ?? profName ?? null,
              }).eq("id", existing.id);
              ghLinked++;
            }
          } else {
            await sb.from("persons").insert({
              emails: [profEmail],
              github_users: [owner],
              real_name: profName,
              outreach_status: "new",
              source_events: [{ kind: "github_owner", repo: p.github_repo, found_at: new Date().toISOString() }],
            });
            newPersons++;
          }
          ownerEnriched++;
        }
      }

      // Pull commit emails
      const commitsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits?per_page=10`,
        { headers: ghHeaders, signal: AbortSignal.timeout(10_000) },
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
            await sb.from("persons").insert({
              emails: [ce],
              source_events: [{ kind: "github_commit", repo: p.github_repo, found_at: new Date().toISOString() }],
            });
            newPersons++;
          }
        }
      } else if (commitsRes.status === 403 || commitsRes.status === 429) {
        errors++;
        await sleep(2000);
      }
    } catch {
      errors++;
    }
    if (processed % 5 === 0) {
      process.stdout.write(`  ${processed}/${items.length} (owner+=${ownerEnriched}, gh-link+=${ghLinked}, new=${newPersons}, err=${errors})\r`);
    }
    await sleep(GH_TOKEN ? 150 : 500);
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - start;
const summary = {
  agent: String(slice.agent),
  strategy: "gh-repo",
  scanned: processed,
  wins: ownerEnriched + ghLinked,
  errors,
  new_persons: newPersons,
  duration_ms,
};
console.log(JSON.stringify(summary));
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");
