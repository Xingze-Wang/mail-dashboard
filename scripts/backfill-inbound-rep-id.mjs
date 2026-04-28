// One-shot backfill: stamp rep_id on historical inbound_emails rows.
//
// Mirrors the resolution logic in src/lib/inbound-attribution.ts:
//   1. Extract bare email from inbound.to (handles JSON-array, "Name <addr>", bare addr).
//   2. Match against sales_reps.sender_email (exact, then substring).
//   3. Fallback: look up emails table by thread_id and reuse that rep_id.
//   4. Otherwise leave NULL.
//
// Run: node scripts/backfill-inbound-rep-id.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://erguqrisqtugfysofwdd.supabase.co";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/** Pull the bare email out of "Name <addr@x>" or "addr@x" or '["addr@x"]'. */
function extractEmail(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed) && parsed.length > 0) s = String(parsed[0]).trim();
    } catch {
      // not valid JSON, fall through
    }
  }
  s = s.split(",")[0].trim();
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).toLowerCase().trim();
  return addr.includes("@") ? addr : null;
}

function resolveByRecipient(toRaw, reps) {
  const recipient = extractEmail(toRaw);
  if (!recipient) return null;
  // Exact match first.
  for (const r of reps) {
    if (r.sender_email && r.sender_email.toLowerCase() === recipient) return r.id;
  }
  // Substring fallback — recipient string contains sender_email.
  for (const r of reps) {
    if (r.sender_email && recipient.includes(r.sender_email.toLowerCase())) return r.id;
  }
  return null;
}

async function resolveByThread(threadId) {
  if (!threadId) return null;
  const { data, error } = await supabase
    .from("emails")
    .select("rep_id")
    .eq("thread_id", threadId)
    .not("rep_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`thread lookup failed for ${threadId}:`, error.message);
    return null;
  }
  return data?.rep_id ?? null;
}

async function main() {
  // 1. Load all sales reps.
  const { data: reps, error: repsErr } = await supabase
    .from("sales_reps")
    .select("id, sender_email");
  if (repsErr) throw repsErr;
  console.log(`Loaded ${reps.length} sales reps.`);

  // 2. Load all inbound rows missing rep_id.
  const { data: rows, error: rowsErr } = await supabase
    .from("inbound_emails")
    .select("id, to, thread_id, rep_id")
    .is("rep_id", null);
  if (rowsErr) throw rowsErr;
  console.log(`Found ${rows.length} inbound rows with rep_id IS NULL.`);

  let recipientMatched = 0;
  let threadMatched = 0;
  let stillNull = 0;

  for (const row of rows) {
    let repId = resolveByRecipient(row.to, reps);
    let source = "recipient";
    if (!repId) {
      repId = await resolveByThread(row.thread_id);
      source = repId ? "thread" : "none";
    }

    if (!repId) {
      stillNull++;
      continue;
    }

    const { error: patchErr } = await supabase
      .from("inbound_emails")
      .update({ rep_id: repId })
      .eq("id", row.id);

    if (patchErr) {
      console.warn(`PATCH failed for inbound id=${row.id}:`, patchErr.message);
      stillNull++;
      continue;
    }

    if (source === "recipient") recipientMatched++;
    else if (source === "thread") threadMatched++;
  }

  console.log("---");
  console.log(`Recipient match: ${recipientMatched}`);
  console.log(`Thread fallback: ${threadMatched}`);
  console.log(`Still NULL:      ${stillNull}`);

  // 5-row sample of after state.
  const { data: sample, error: sampleErr } = await supabase
    .from("inbound_emails")
    .select("id, to, rep_id")
    .order("id", { ascending: false })
    .limit(5);
  if (sampleErr) {
    console.warn("sample fetch failed:", sampleErr.message);
    return;
  }
  console.log("---");
  console.log("After-state sample (recipient -> rep_id):");
  for (const s of sample) {
    console.log(`  id=${s.id}  ${extractEmail(s.to) ?? "(no recipient)"}  ->  rep_id=${s.rep_id ?? "NULL"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
