// Smoke-test the new shared auto-execute pathway. Verifies both
// remember_about_rep AND record_admin_request fire correctly with the
// suffix returned, and that record_admin_request actually writes a
// row to admin_inbox + pushes the Lark card.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { tryAutoExecuteSafe } = await import("/Users/xingzewang/Desktop/mail/src/lib/auto-execute-safe.ts");
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const session = { repId: 5, role: "admin", repName: "Xingze" };

// Test 1: remember_about_rep
console.log("\n=== test 1: remember_about_rep ===");
const t1 = await tryAutoExecuteSafe(session, {
  action: "remember_about_rep",
  kind: "self_critique",
  body: "Smoke test: this row is from _test-auto-exec.mjs at " + new Date().toISOString().slice(0, 16),
  scope: "org",
});
console.log(JSON.stringify(t1, null, 2));

// Test 2: record_admin_request — the one the user complained about
console.log("\n=== test 2: record_admin_request (the bug) ===");
const t2 = await tryAutoExecuteSafe(session, {
  action: "record_admin_request",
  kind: "request",
  headline: "Smoke test: verify auto-exec writes to admin_inbox " + Date.now(),
  body: "If this row lands in admin_inbox AND admin gets a Lark card, the fix worked. Otherwise the suffix lies.",
  source_rep_id: 5,
});
console.log(JSON.stringify(t2, null, 2));

// Verify admin_inbox row exists
const { data: inbox } = await sb
  .from("admin_inbox")
  .select("id, kind, headline, status, created_at")
  .ilike("headline", "Smoke test: verify auto-exec writes%")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("\nLatest admin_inbox match:", inbox);

// Verify helper_learnings row exists from test 1
const { data: learn } = await sb
  .from("helper_learnings")
  .select("id, kind, body, created_at")
  .ilike("body", "Smoke test: this row is from _test-auto-exec.mjs%")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("\nLatest helper_learnings match:", learn);
