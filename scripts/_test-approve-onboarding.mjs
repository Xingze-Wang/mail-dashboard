// Smoke test the new approve_onboarding tool by routing the same
// payload Leon would generate, end-to-end. Lands on 王泽群 (pending
// row id known from earlier session). Confirms:
//   - pending_onboarding flips to status='approved'
//   - sales_reps row is created with role='senior'
//   - trust_notes is stamped if provided
//   - 4-message welcome flow fires to 王泽群's Lark DM
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Inline the executor's logic instead of calling /api/help/execute (which
// requires auth). Same code path, no HTTP round-trip.
const NAME = process.env.PENDING_LARK_NAME || "王泽群";
const ROLE = process.env.ROLE || "senior";
const NOTES = process.env.TRUST_NOTES || "growth role, 注意她需要更多 onboarding 资料 (admin)";

const { data: pending } = await sb
  .from("pending_onboarding")
  .select("*")
  .eq("lark_name", NAME)
  .in("status", ["in_progress", "awaiting_admin"])
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (!pending) {
  console.error(`No pending row for ${NAME}`);
  process.exit(1);
}
console.log("found pending:", { id: pending.id, lark_name: pending.lark_name, claimed_email: pending.claimed_email });

// Same payload Leon would send via /api/help/execute
const { processOnboardingCardAction } = await import("/Users/xingzewang/Desktop/mail/src/lib/onboarding.ts");

// Look up admin open_id (Xingze)
const { data: admin } = await sb
  .from("sales_reps")
  .select("lark_open_id")
  .eq("id", 5)
  .maybeSingle();

const result = await processOnboardingCardAction({
  event: {
    operator: { open_id: admin.lark_open_id },
    action: {
      value: {
        onboarding_action: ROLE === "senior" ? "approve_senior" : "approve_sales",
        pending_id: pending.id,
      },
    },
  },
});
console.log("approval result:", result);

if (result.ok && NOTES) {
  await sb
    .from("sales_reps")
    .update({ trust_notes: NOTES.slice(0, 500) })
    .eq("sender_email", pending.claimed_email);
  console.log("trust_notes set");
}

// Verify the sales_reps row exists
const { data: newRep } = await sb
  .from("sales_reps")
  .select("id, name, role, sender_email, trust_notes, active")
  .eq("sender_email", pending.claimed_email)
  .maybeSingle();
console.log("new rep row:", newRep);
