/**
 * Rotate rep_id=3's password to the bcrypt hash that's still sitting on
 * the (now-approved) pending_onboarding row. Ethan set THIS password
 * during onboarding; he'll expect it to work. Without this rotation,
 * he'd hit a "wrong password" wall and need an admin reset DM.
 *
 * The pending_onboarding.password_hash is already a bcrypt hash of
 * what Ethan typed — we just lift it onto rep_id=3.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const PENDING_ID = "1cf9be11-3627-4dd1-ac55-feb7729b8b45";
const ETHAN_REP_ID = 3;

const { data: pending } = await sb
  .from("pending_onboarding")
  .select("password_hash, claimed_name")
  .eq("id", PENDING_ID)
  .maybeSingle();

if (!pending?.password_hash) {
  console.error("No password_hash on pending row");
  process.exit(1);
}

const { error } = await sb
  .from("sales_reps")
  .update({ password_hash: pending.password_hash })
  .eq("id", ETHAN_REP_ID);

if (error) {
  console.error("Rotation failed:", error.message);
  process.exit(1);
}

console.log(`✅ rep_id=${ETHAN_REP_ID} password rotated to the hash Ethan set during onboarding.`);
console.log("He can log in with ethan@compute.miracleplus.com + the password he just typed in DM.");
