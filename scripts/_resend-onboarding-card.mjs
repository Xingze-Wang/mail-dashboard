// Re-send the admin onboarding-approval card for a specific pending row.
// Usage: PENDING_LARK_NAME='王泽群' npx tsx scripts/_resend-onboarding-card.mjs
//
// Reads the pending_onboarding row, calls sendOnboardingCard which
// pushes a fresh interactive card into the admin's Lark DM. The new
// card uses the latest webhook handler (toast ack, 200340 fix) so
// clicking Approve/Deny should work this time.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const NAME = process.env.PENDING_LARK_NAME || "王泽群";

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const { data: pending, error } = await sb
  .from("pending_onboarding")
  .select("*")
  .eq("lark_name", NAME)
  .eq("status", "in_progress")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (error) { console.error("DB err:", error.message); process.exit(1); }
if (!pending) { console.error(`No in_progress pending row for "${NAME}"`); process.exit(1); }

console.log("Found pending row:", {
  id: pending.id,
  lark_name: pending.lark_name,
  claimed_email: pending.claimed_email,
  claimed_role: pending.claimed_role,
  step: pending.step,
  open_id: pending.lark_open_id,
});

const { sendOnboardingCard } = await import("/Users/xingzewang/Desktop/mail/src/lib/onboarding.ts");
await sendOnboardingCard(pending);
console.log("Card re-sent. Admin should see it in their Lark DM.");
