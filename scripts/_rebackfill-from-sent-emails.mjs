// Re-derive (paper title, author given-name) from the canonical source
// of truth: the emails we actually sent. The Python scanner's
// (title, author_name) columns on pipeline_leads are upstream-derived
// and have known misjoins (Zhangcheng Wang misattributed to USTC,
// Jiaming Hu to Penn State, etc — see wave-3 shard reports). The
// SUBJECT we sent always contains the real paper title, and the
// "<FirstName>你好" greeting always contains the name we addressed.
//
// Patterns:
//   subject: "Invitation to Apply - <TITLE>的潜在算力支持机会"
//   body row 1: "<FIRSTNAME>你好，..."
//
// Joins emails → pipeline_leads via thread_id (set at send time in
// src/app/api/pipeline/send/route.ts line ~333).
//
// Writes:
//   pipeline_leads.title           ← extracted paper title (only if existing differs)
//   pipeline_leads.first_name      ← extracted greeting name (null-fill, never overwrite)
//
// Does NOT touch author_name or s2_author_id — those go through the
// regular enrichment pipeline (lib/h-index-enrich) once first_name +
// title are clean.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const TITLE_RE = /^Invitation to Apply\s*-\s*(.+?)的潜在算力支持机会\s*$/;
const NAME_RE = /^([A-Za-z一-鿿\-\.]{1,40})你好[，,]/;

function extractTitle(subject) {
  if (!subject) return null;
  const m = subject.match(TITLE_RE);
  if (!m) return null;
  return m[1].trim();
}

function extractGreetingName(html) {
  if (!html) return null;
  const text = String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // First "<Name>你好" anywhere in the first 200 chars
  const head = text.slice(0, 200);
  const m = head.match(NAME_RE);
  if (!m) return null;
  return m[1].trim();
}

// Drain all sent emails.
async function drainEmails() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("emails")
      .select("id, to, thread_id, subject, html, created_at")
      .in("status", ["sent", "delivered", "clicked", "bounced", "complained", "replied"])
      .not("to", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

console.log("[rebackfill] draining sent emails...");
const emails = await drainEmails();
console.log("[rebackfill] sent emails:", emails.length);

// First-write wins per RECIPIENT (oldest send to that email kept). Join
// to leads via emails.to → pipeline_leads.author_email instead of
// thread_id — many old leads have lost their thread_id link.
const perRecipient = new Map();
for (const e of emails) {
  const to = (e.to || "").trim().toLowerCase();
  if (!to) continue;
  if (perRecipient.has(to)) continue;
  perRecipient.set(to, e);
}
console.log("[rebackfill] distinct recipients:", perRecipient.size);

// Map recipient → lead row(s). One recipient can have multiple leads
// (same person, multiple papers over time) — we update all of them.
const recipients = [...perRecipient.keys()];
const leadsByEmail = new Map();
for (let i = 0; i < recipients.length; i += 200) {
  const slice = recipients.slice(i, i + 200);
  const { data } = await sb.from("pipeline_leads").select("id, author_email, title, first_name, author_name").in("author_email", slice);
  for (const r of data || []) {
    const key = (r.author_email || "").toLowerCase();
    if (!leadsByEmail.has(key)) leadsByEmail.set(key, []);
    leadsByEmail.get(key).push(r);
  }
}
const leadCount = [...leadsByEmail.values()].reduce((s, arr) => s + arr.length, 0);
console.log("[rebackfill] matched", leadsByEmail.size, "recipients →", leadCount, "leads");

let titleFixed = 0, titleSkipped = 0, titleMiss = 0;
let nameFilled = 0, nameSkipped = 0, nameMiss = 0;

for (const [toEmail, email] of perRecipient) {
  const leads = leadsByEmail.get(toEmail) || [];
  if (leads.length === 0) continue;

  const extractedTitle = extractTitle(email.subject);
  const extractedName = extractGreetingName(email.html);

  for (const lead of leads) {
    const upd = {};

    // Title: overwrite if the extracted title differs from current.
    // Most leads have only one paper, but if a lead row was reused
    // for a second paper we'd update with the most-recent send's title
    // (perRecipient is first-write-wins; future enhancement: also key
    // by arxiv_id when present).
    if (extractedTitle) {
      if (!lead.title || lead.title.trim() !== extractedTitle) {
        upd.title = extractedTitle;
        titleFixed++;
      } else {
        titleSkipped++;
      }
    } else {
      titleMiss++;
    }

    // Name: only fill if first_name is blank — don't blow away rows
    // where the Python scanner got it right.
    if (extractedName) {
      if (!lead.first_name || lead.first_name.trim().length === 0) {
        upd.first_name = extractedName;
        nameFilled++;
      } else {
        nameSkipped++;
      }
    } else {
      nameMiss++;
    }

    if (Object.keys(upd).length > 0) {
      const { error } = await sb.from("pipeline_leads").update(upd).eq("id", lead.id);
      if (error) console.error(" err", lead.id.slice(0, 8), error.message);
    }
  }
}

console.log("\n[rebackfill] DONE:");
console.log("  title:  fixed=", titleFixed, " already-correct=", titleSkipped, " unextracted=", titleMiss);
console.log("  name:   filled=", nameFilled, " already-set=", nameSkipped, " unextracted=", nameMiss);
