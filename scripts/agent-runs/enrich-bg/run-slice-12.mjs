// Slice-12 runner — gh-repo strategy on a fixed item list.
// Mirrors strategyGhRepo in scripts/enrich-net.mjs but bounded to the slice.
// Writes a one-line JSONL summary to scripts/agent-runs/enrich-bg/summary.jsonl.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const slicePath = join(__dirname, "slice-12.json");
const summaryPath = join(__dirname, "summary.jsonl");

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD_EMAIL_DOMAINS = new Set(["adobe.com", "ams.org", "arxiv.org", "ctan.org", "openreview.net", "tex.stackexchange.com", "ieee.org", "acm.org"]);
function isRealEmail(e) {
  const d = (e.split("@")[1] ?? "").toLowerCase();
  if (BAD_EMAIL_DOMAINS.has(d)) return false;
  if ((e.split("@")[0] ?? "").length < 2) return false;
  return true;
}

const slice = JSON.parse(readFileSync(slicePath, "utf8"));
if (slice.strategy !== "gh-repo") {
  console.error(`Expected strategy gh-repo, got ${slice.strategy}`);
  process.exit(1);
}
const items = slice.items ?? [];
console.log(`agent ${slice.agent} / strategy ${slice.strategy} / items ${items.length}`);

const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const ghHeaders = { "User-Agent": "qiji-enrich/1.0", "Accept": "application/vnd.github+json" };
if (ghToken) ghHeaders["Authorization"] = `Bearer ${ghToken}`;

let scanned = 0, ownerEnriched = 0, ghLinked = 0, newEmails = 0, newPersons = 0, errors = 0;
const t0 = Date.now();

const queue = items.slice();
const CONC = 4;

async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    scanned++;
    const repoStr = (p.github_repo ?? "").replace(/\.git$/i, "");
    const [owner, repo] = repoStr.split("/");
    if (!owner || !repo) { continue; }
    try {
      const profRes = await fetch(`https://api.github.com/users/${owner}`, {
        signal: AbortSignal.timeout(10_000),
        headers: ghHeaders,
      });
      if (profRes.status === 403 || profRes.status === 429) {
        errors++;
        const reset = profRes.headers.get("x-ratelimit-reset");
        console.log(`  rate limited on owner ${owner} (status ${profRes.status}); reset=${reset}`);
        await sleep(2000);
        continue;
      }
      if (!profRes.ok) { errors++; continue; }
      const prof = await profRes.json();
      const profEmail = prof.email?.toLowerCase();
      const profName = prof.name;
      if (profEmail && isRealEmail(profEmail)) {
        const { data: existing } = await sb.from("persons").select("id, github_users, real_name").contains("emails", [profEmail]).maybeSingle();
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
            source_events: [{ kind: "github_owner", repo: repoStr, found_at: new Date().toISOString() }],
          });
          newEmails++;
          newPersons++;
        }
        ownerEnriched++;
      }

      const commitsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=10`, {
        signal: AbortSignal.timeout(10_000),
        headers: ghHeaders,
      });
      if (commitsRes.status === 403 || commitsRes.status === 429) {
        errors++;
        await sleep(2000);
      } else if (commitsRes.ok) {
        const commits = await commitsRes.json();
        const commitEmails = new Set();
        for (const c of (Array.isArray(commits) ? commits : [])) {
          const e = c.commit?.author?.email?.toLowerCase();
          if (e && isRealEmail(e) && !e.includes("noreply.github.com")) commitEmails.add(e);
        }
        for (const ce of commitEmails) {
          const { data: dup } = await sb.from("persons").select("id").contains("emails", [ce]).maybeSingle();
          if (!dup) {
            await sb.from("persons").insert({
              emails: [ce],
              source_events: [{ kind: "github_commit", repo: repoStr, found_at: new Date().toISOString() }],
            });
            newEmails++;
            newPersons++;
          }
        }
      }
    } catch (err) {
      errors++;
    }
    if (scanned % 5 === 0) {
      process.stdout.write(`  ${scanned}/${items.length} (owner+=${ownerEnriched}, gh-link+=${ghLinked}, new=${newEmails}, err=${errors})\r`);
    }
    await sleep(ghToken ? 250 : 1100);
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");
const duration_ms = Date.now() - t0;
const wins = ownerEnriched + ghLinked + newEmails;
console.log(`\nDONE — scanned=${scanned}, owner+=${ownerEnriched}, gh-link+=${ghLinked}, new emails=${newEmails}, errors=${errors}, ${duration_ms}ms`);

const summary = {
  agent: String(slice.agent),
  strategy: slice.strategy,
  scanned,
  wins,
  errors,
  new_persons: newPersons,
  duration_ms,
};
appendFileSync(summaryPath, JSON.stringify(summary) + "\n");
console.log(`summary appended: ${summaryPath}`);
