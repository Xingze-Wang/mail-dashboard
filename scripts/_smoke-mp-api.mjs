// MP Open API smoke. Run against staging.
// 1. Health check
// 2. Pull recent outbound emails from our DB
// 3. For each, search MP API by email
// 4. Report: matched / submitted application
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { mpGetUserMe, mpSearchContactsByEmail } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/miracleplus-api.ts"
);

console.log("[1/4] Health");
console.log("  ", JSON.stringify(await mpGetUserMe()));

console.log("\n[2/4] Pull recent outbound emails");
const { createClient } = await import("@supabase/supabase-js");
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data: emails } = await s
  .from("emails")
  .select("to, created_at")
  .not("to", "is", null)
  .order("created_at", { ascending: false })
  .limit(30);
console.log(`  pulled ${emails?.length ?? 0}`);

console.log("\n[3/4] Probe MP for each");
let matches = 0, submitted = 0, probed = 0;
for (const e of emails ?? []) {
  const rawTo = e.to;
  const m = String(rawTo).match(/<([^>]+)>/);
  const addr = (m ? m[1] : String(rawTo)).trim().toLowerCase();
  if (!addr.includes("@")) continue;
  probed++;
  const results = await mpSearchContactsByEmail(addr);
  if (results.length === 0) {
    console.log(`  - ${addr}: no MP match`);
    continue;
  }
  matches++;
  const c = results[0];
  const conv = c.application_progress
    ? `✓ ${c.application_progress} (stage=${c.application_stage}, n=${c.applications_number})`
    : `(no application)`;
  if (c.application_progress) submitted++;
  console.log(`  + ${addr}: MP #${c.id} ${c.name ?? "?"} — ${conv}`);
  await new Promise((r) => setTimeout(r, 200));
}

console.log("\n[4/4] Summary");
console.log(`  probed:    ${probed}`);
console.log(`  matched:   ${matches}`);
console.log(`  submitted: ${submitted}`);
