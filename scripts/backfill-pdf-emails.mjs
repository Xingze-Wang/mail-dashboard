// Strategy 3: For every known paper (papers table), pull the PDF cover page
// and extract emails + repos. The corresponding-author email is the gold
// disambiguator — if it matches a person we already have, identity is
// confirmed; if it's NEW, attach as alias.
//
// Concurrency: 8 parallel fetches. arxiv tolerates this.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const EMAIL_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HF_PATTERN = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;

const BAD_DOMAINS = new Set(["adobe.com", "ams.org", "arxiv.org", "ctan.org", "openreview.net", "tex.stackexchange.com", "ieee.org", "acm.org"]);

function ok(email) {
  const lower = email.toLowerCase();
  const dom = lower.split("@")[1] ?? "";
  if (BAD_DOMAINS.has(dom)) return false;
  if ((lower.split("@")[0] ?? "").length < 2) return false;
  return true;
}

function norm(r) { return r.replace(/[.,)\]\s]+$/, "").trim(); }
function pick(arr) {
  const f = arr.filter((r) => !r.toLowerCase().startsWith("anonymous/"));
  const c = new Map();
  for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function extract(arxivId) {
  const id = arxivId.replace(/v\d+$/, "");
  const url = `https://arxiv.org/pdf/${id}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { Range: "bytes=0-153600" },
    });
    if (!res.ok && res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let text = "";
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      text += (c >= 32 && c < 127) || c === 10 || c === 13 ? String.fromCharCode(c) : " ";
    }
    text = text.replace(/\s+/g, " ");
    const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].filter(ok).slice(0, 20);
    const hf = pick([...text.matchAll(HF_PATTERN)].map((m) => norm(m[1])));
    const gh = pick([...text.matchAll(GH_PATTERN)].map((m) => norm(m[1])));
    return { emails, hf_repo: hf, github_repo: gh };
  } catch {
    return null;
  }
}

// Pull all papers
const { data: papers } = await sb.from("papers").select("arxiv_id, hf_repo, github_repo").not("arxiv_id", "is", null);
console.log(`PDF backfill: ${papers.length} papers to scan`);

let done = 0, withEmails = 0, totalEmails = 0, repoUpdates = 0;
const queue = [...papers];
const CONCURRENCY = 8;
async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    done++;
    const ext = await extract(p.arxiv_id);
    if (!ext) {
      if (done % 25 === 0) process.stdout.write(`  ${done}/${papers.length} (emails=${withEmails})\r`);
      continue;
    }
    if (ext.emails.length > 0) {
      withEmails++;
      totalEmails += ext.emails.length;
      // Persist emails on paper row via source_events-style metadata: store
      // as a JSONB-ish list in a new column. Easiest: write to a separate
      // row in a paper_emails table — but for now, dump to a JSONL file so
      // the next stage can do the persons-merge logic.
      console.log(JSON.stringify({ arxiv_id: p.arxiv_id, emails: ext.emails, hf: ext.hf_repo, gh: ext.github_repo }));
    }
    // Update paper repo if we found new ones
    const update = {};
    if (ext.hf_repo && !p.hf_repo) update.hf_repo = ext.hf_repo;
    if (ext.github_repo && !p.github_repo) update.github_repo = ext.github_repo;
    if (Object.keys(update).length > 0) {
      await sb.from("papers").update(update).eq("arxiv_id", p.arxiv_id);
      repoUpdates++;
    }
    if (done % 25 === 0) process.stdout.write(`  ${done}/${papers.length} (emails=${withEmails}, total=${totalEmails}, repos+=${repoUpdates})\r`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write("\n");

console.log(`\nPDF summary: ${done} scanned, ${withEmails} with emails (total ${totalEmails}), ${repoUpdates} repo updates`);
