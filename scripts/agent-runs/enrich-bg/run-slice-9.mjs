// Slice-9 runner — gh-repo strategy
// Pulls owner profile + recent commits from GitHub API, attaches owner email +
// name + github_users to matching person OR creates new persons rows.
//
// Treats each new email as an independent identity (NOT alias of co-authors).
// Idempotent: only writes nullable fields, only inserts if email not already
// on a person.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const GH_TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const SLICE_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-9.json";
const SUMMARY_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";
const AGENT = 9;
const STRATEGY = "gh-repo";

const BAD_EMAIL_DOMAINS = new Set([
  "adobe.com", "ams.org", "arxiv.org", "ctan.org", "openreview.net",
  "tex.stackexchange.com", "ieee.org", "acm.org",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRealEmail(e) {
  if (!e) return false;
  const d = (e.split("@")[1] ?? "").toLowerCase();
  if (BAD_EMAIL_DOMAINS.has(d)) return false;
  if ((e.split("@")[0] ?? "").length < 2) return false;
  if (e.includes("noreply.github.com")) return false;
  if (e.includes("users.noreply.github.com")) return false;
  return true;
}

async function ghFetch(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "qiji-enrich-agent-9",
    },
  });
  return res;
}

const slice = JSON.parse(readFileSync(SLICE_PATH, "utf8"));
const items = slice.items ?? [];
console.log(`agent=${AGENT} strategy=${STRATEGY} items=${items.length}`);

const t0 = Date.now();
let scanned = 0;
let wins = 0;       // any successful person-update or person-insert
let errors = 0;
let newPersons = 0; // inserted persons rows
let ownerEnriched = 0;
let ghLinked = 0;

const CONC = 4;
const queue = items.slice();

async function worker(wid) {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    scanned++;
    const repoFull = (p.github_repo ?? "").replace(/\.git$/, "");
    const [owner, repo] = repoFull.split("/");
    if (!owner || !repo) {
      errors++;
      continue;
    }
    let didWin = false;
    try {
      // ─── owner profile ───
      const profRes = await ghFetch(`https://api.github.com/users/${owner}`);
      if (profRes.status === 404) {
        // Owner doesn't exist — skip silently
      } else if (!profRes.ok) {
        errors++;
        console.warn(`  [${wid}] ${owner}/${repo} profile ${profRes.status}`);
      } else {
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
            const update = {};
            if (!ghs.has(owner)) {
              ghs.add(owner);
              update.github_users = [...ghs];
            }
            if (!existing.real_name && profName) {
              update.real_name = profName;
            }
            if (Object.keys(update).length > 0) {
              const { error } = await sb.from("persons").update(update).eq("id", existing.id);
              if (error) {
                errors++;
                console.warn(`  [${wid}] update fail ${owner}: ${error.message}`);
              } else {
                ghLinked++;
                didWin = true;
              }
            }
          } else {
            const { error } = await sb.from("persons").insert({
              emails: [profEmail],
              github_users: [owner],
              real_name: profName ?? null,
              outreach_status: "new",
              source_events: [{ kind: "github_owner", repo: repoFull, found_at: new Date().toISOString() }],
            });
            if (error) {
              errors++;
              console.warn(`  [${wid}] insert fail ${owner}: ${error.message}`);
            } else {
              newPersons++;
              didWin = true;
            }
          }
          ownerEnriched++;
        }
      }

      // ─── recent commits ───
      const commitsRes = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=10`);
      if (commitsRes.status === 404 || commitsRes.status === 409) {
        // empty or missing repo — silent
      } else if (!commitsRes.ok) {
        if (commitsRes.status !== 403) {
          errors++;
        }
      } else {
        const commits = await commitsRes.json();
        const commitEmails = new Map(); // email → name
        for (const c of (Array.isArray(commits) ? commits : [])) {
          const e = c.commit?.author?.email?.toLowerCase();
          const n = c.commit?.author?.name ?? null;
          if (e && isRealEmail(e)) {
            if (!commitEmails.has(e)) commitEmails.set(e, n);
          }
        }
        for (const [ce, cn] of commitEmails) {
          const { data: dup } = await sb
            .from("persons")
            .select("id")
            .contains("emails", [ce])
            .maybeSingle();
          if (dup) continue;
          const { error } = await sb.from("persons").insert({
            emails: [ce],
            real_name: cn,
            outreach_status: "new",
            source_events: [{ kind: "github_commit", repo: repoFull, found_at: new Date().toISOString() }],
          });
          if (error) {
            if (!String(error.message).includes("duplicate")) {
              errors++;
              console.warn(`  [${wid}] commit-insert fail ${ce}: ${error.message}`);
            }
          } else {
            newPersons++;
            didWin = true;
          }
        }
      }
    } catch (e) {
      errors++;
      console.warn(`  [${wid}] ${owner}/${repo} ex: ${e.message}`);
    }
    if (didWin) wins++;
    if (scanned % 5 === 0) {
      process.stdout.write(`  scanned=${scanned}/${items.length} wins=${wins} new=${newPersons} link+=${ghLinked} err=${errors}\r`);
    }
    await sleep(150);
  }
}

await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
process.stdout.write("\n");

const duration_ms = Date.now() - t0;
const summary = {
  agent: String(AGENT),
  strategy: STRATEGY,
  scanned,
  wins,
  errors,
  new_persons: newPersons,
  duration_ms,
  owner_enriched: ownerEnriched,
  gh_linked: ghLinked,
};
console.log(JSON.stringify(summary, null, 2));
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");
console.log(`appended → ${SUMMARY_PATH}`);
