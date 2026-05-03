// Agent 15 — pdf-cover for slice-15 only.
// Mirrors strategyPdfCover in scripts/enrich-net.mjs but iterates the
// pre-sliced (arxiv_id, hf_repo, github_repo) list rather than scanning
// every paper. Idempotent: only writes nullable fields on `papers`, and
// only inserts a new persons row when no existing person has the email.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";

const SLICE_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-15.json";
const SUMMARY_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const HF_PATTERN = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;
const EMAIL_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BAD_EMAIL_DOMAINS = new Set([
  "adobe.com", "ams.org", "arxiv.org", "ctan.org", "openreview.net",
  "tex.stackexchange.com", "ieee.org", "acm.org",
]);

function normRepo(r) { return r.replace(/[.,)\]\s]+$/, "").trim(); }
function pickRepo(arr) {
  const f = arr.filter((r) => !r.toLowerCase().startsWith("anonymous/"));
  const c = new Map();
  for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
function isRealEmail(e) {
  const d = (e.split("@")[1] ?? "").toLowerCase();
  if (BAD_EMAIL_DOMAINS.has(d)) return false;
  if ((e.split("@")[0] ?? "").length < 2) return false;
  return true;
}

const slice = JSON.parse(readFileSync(SLICE_PATH, "utf8"));
const items = slice.items ?? [];
const start = Date.now();
console.log(`agent ${slice.agent} (pdf-cover): ${items.length} papers`);

const queue = [...items];
let scanned = 0;
let withEmails = 0;
let totalEmails = 0;
let repoUpdates = 0;
let newPersons = 0;
let errors = 0;
const CONC = 8;

async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    scanned++;
    const id = String(p.arxiv_id).replace(/v\d+$/, "");
    try {
      const res = await fetch(`https://arxiv.org/pdf/${id}`, {
        signal: AbortSignal.timeout(20_000),
        headers: { Range: "bytes=0-153600" },
      });
      if (!res.ok && res.status !== 206) continue;
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let text = "";
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        text += (c >= 32 && c < 127) || c === 10 || c === 13
          ? String.fromCharCode(c)
          : " ";
      }
      text = text.replace(/\s+/g, " ");

      const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))]
        .filter(isRealEmail)
        .slice(0, 20);
      const hf = pickRepo([...text.matchAll(HF_PATTERN)].map((m) => normRepo(m[1])));
      const gh = pickRepo([...text.matchAll(GH_PATTERN)].map((m) => normRepo(m[1])));

      const update = {};
      if (hf && !p.hf_repo) update.hf_repo = hf;
      if (gh && !p.github_repo) update.github_repo = gh;
      if (Object.keys(update).length > 0) {
        const { error: upErr } = await sb
          .from("papers")
          .update(update)
          .eq("arxiv_id", p.arxiv_id);
        if (upErr) errors++;
        else repoUpdates++;
      }

      if (emails.length > 0) {
        withEmails++;
        totalEmails += emails.length;
        for (const email of emails) {
          const { data: dup, error: selErr } = await sb
            .from("persons")
            .select("id")
            .contains("emails", [email])
            .maybeSingle();
          if (selErr) { errors++; continue; }
          if (dup) continue;
          const { error: insErr } = await sb.from("persons").insert({
            emails: [email],
            outreach_status: "new",
            source_events: [{
              kind: "paper_pdf",
              arxiv_id: id,
              found_at: new Date().toISOString(),
            }],
          });
          if (insErr) errors++;
          else newPersons++;
        }
      }
    } catch {
      errors++;
    }
    if (scanned % 25 === 0) {
      process.stdout.write(
        `  ${scanned}/${items.length} (emails=${withEmails}, repos+=${repoUpdates}, new_persons=${newPersons})\r`,
      );
    }
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - start;
const summary = {
  agent: String(slice.agent),
  strategy: slice.strategy,
  scanned,
  wins: withEmails + repoUpdates,
  errors,
  new_persons: newPersons,
  duration_ms,
};
console.log(
  `done: scanned=${scanned} withEmails=${withEmails} totalEmails=${totalEmails} repoUpdates=${repoUpdates} newPersons=${newPersons} errors=${errors} duration_ms=${duration_ms}`,
);
console.log(JSON.stringify(summary));
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");
console.log("summary appended:", summary);
