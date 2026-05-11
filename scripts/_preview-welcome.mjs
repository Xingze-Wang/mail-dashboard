// One-shot: re-fire the 4-part welcome flow to the user's Lark DM
// for preview. Targets Xingze's open_id by default so admin can see
// what newly-onboarded reps will receive. Doesn't mutate any DB
// state — just calls sendWalkthrough() with a synthetic PendingRow
// pointing at the chosen open_id + rep_id.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { sendWalkthrough } = await import("/Users/xingzewang/Desktop/mail/src/lib/onboarding.ts");
const { createClient } = await import("@supabase/supabase-js");

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Hard-target Xingze for preview. Override via PREVIEW_OPEN_ID env if
// admin wants to see it land somewhere else.
const TARGET_OPEN_ID = process.env.PREVIEW_OPEN_ID ?? "ou_395f934f5add3c398bed6be8f258246b";

// Pick the target rep row. If the open_id maps to an existing rep, use
// that rep's id + sender_email. If not, fall back to rep_id=5 (Xingze)
// so the message still has a sane rep_name in the greeting line.
const { data: byOpenId } = await sb
  .from("sales_reps")
  .select("id, sender_email, name")
  .eq("lark_open_id", TARGET_OPEN_ID)
  .maybeSingle();
const repId = byOpenId?.id ?? 5;
const senderEmail = byOpenId?.sender_email ?? "xingze@compute.miracleplus.com";

const synthetic = {
  id: "preview-" + Date.now(),
  lark_open_id: TARGET_OPEN_ID,
  lark_name: byOpenId?.name ?? "王幸泽",
  lark_email: null,
  step: "complete",
  status: "approved",
  claimed_name: byOpenId?.name ?? "Xingze",
  claimed_email: senderEmail,
  claimed_wechat: null,
  password_hash: null,
  claimed_role: byOpenId?.role ?? "admin",
  lark_chat_id: null,
  step_failures: 0,
};

console.log("Firing 4-part welcome →", TARGET_OPEN_ID, "as rep", repId, "(" + senderEmail + ")");
await sendWalkthrough(synthetic, repId, senderEmail);
console.log("Done. Check your Lark DM with Leon.");
