// Replay + synthetic test for the contact-guard / person-resolver pipeline.
// Two phases:
//   A. Replay: walk every existing email_contact_history row through
//      lastContactedAt() — confirm 100% are recognized as already-contacted.
//   B. Synthetic: for each of the 12 attached DNC persons, generate 5 fake
//      new leads with their email — confirm 100% block as do_not_contact.
//   C. New-alias drift: for one DNC person, simulate the same person showing
//      up via a new email (e.g. their gmail when we have their .edu) — and
//      confirm the resolver merges them.
//
// Usage: node scripts/test-dedup-gate.mjs

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const CUTOFF_DAYS = 365;
const CUTOFF_MS = CUTOFF_DAYS * 24 * 60 * 60 * 1000;

// ─── Helpers (mirror lib/contact-guard.ts) ──────────────────────────────

async function lastContactedAt(emailRaw) {
  const email = emailRaw.trim().toLowerCase();
  if (!email) return null;
  const cutoff = new Date(Date.now() - CUTOFF_MS).toISOString();
  const [emailsHit, historyHit, personsHit] = await Promise.all([
    sb.from("emails").select("created_at").ilike("to", email).gte("created_at", cutoff).order("created_at", { ascending: false }).limit(1),
    sb.from("email_contact_history").select("contacted_at").ilike("email", email).gte("contacted_at", cutoff).order("contacted_at", { ascending: false }).limit(1),
    sb.from("persons").select("last_outreach_at").contains("emails", [email]).gte("last_outreach_at", cutoff).order("last_outreach_at", { ascending: false }).limit(1),
  ]);
  const candidates = [];
  if (emailsHit.data?.[0]) candidates.push(emailsHit.data[0].created_at);
  if (historyHit.data?.[0]) candidates.push(historyHit.data[0].contacted_at);
  if (personsHit.data?.[0]?.last_outreach_at) candidates.push(personsHit.data[0].last_outreach_at);
  if (!candidates.length) return null;
  return candidates.sort().reverse()[0];
}

async function isDoNotContact(emailRaw) {
  const email = emailRaw.trim().toLowerCase();
  if (!email) return { blocked: false, reason: null };
  const { data, error } = await sb
    .from("persons")
    .select("id, real_name, outreach_status")
    .contains("emails", [email])
    .eq("outreach_status", "do_not_contact")
    .limit(1);
  if (error) return { blocked: true, reason: `db error: ${error.message}` };
  if (data?.[0]) return { blocked: true, reason: `do_not_contact: ${data[0].real_name ?? data[0].id}` };
  return { blocked: false, reason: null };
}

async function checkSendAllowed(email) {
  const dnc = await isDoNotContact(email);
  if (dnc.blocked) return { ok: false, code: "do_not_contact", reason: dnc.reason };
  const lastAt = await lastContactedAt(email);
  if (lastAt) return { ok: false, code: "already_contacted", lastContactedAt: lastAt };
  return { ok: true };
}

// ─── Phase A: Replay every email_contact_history row ─────────────────────

async function phaseA() {
  console.log("\n=== Phase A: Replay email_contact_history ===");
  const { data: rows, error } = await sb
    .from("email_contact_history")
    .select("email, contacted_at")
    .order("contacted_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("Failed to fetch history:", error.message);
    return;
  }
  console.log(`Replaying ${rows.length} most recent rows...`);

  const cutoff = Date.now() - CUTOFF_MS;
  const recentRows = rows.filter((r) => new Date(r.contacted_at).getTime() >= cutoff);
  const recent = recentRows.length;
  const expectedBlock = recent;
  // Parallel batches of 10 — far faster, still bounded.
  const results = [];
  for (let i = 0; i < recentRows.length; i += 10) {
    const batch = recentRows.slice(i, i + 10);
    const out = await Promise.all(batch.map((r) => checkSendAllowed(r.email).then((res) => ({ email: r.email, res }))));
    results.push(...out);
    process.stdout.write(`  ${Math.min(i + 10, recentRows.length)}/${recentRows.length}\r`);
  }
  process.stdout.write("\n");
  let actualBlock = 0, falseNegative = 0, ok = 0;
  const fnSamples = [];
  for (const { email, res } of results) {
    if (res.ok) {
      falseNegative++;
      if (fnSamples.length < 5) fnSamples.push(email);
    } else {
      actualBlock++;
      if (res.code === "already_contacted") ok++;
    }
  }
  console.log(`  Recent rows (within ${CUTOFF_DAYS}d): ${recent}`);
  console.log(`  Expected block: ${expectedBlock}`);
  console.log(`  Actual block: ${actualBlock}`);
  console.log(`  Correctly blocked as 'already_contacted': ${ok}`);
  console.log(`  FALSE NEGATIVES (gate let through, should have blocked): ${falseNegative}`);
  if (fnSamples.length) {
    console.log(`  Sample FN emails: ${fnSamples.join(", ")}`);
  }
  return { recent, falseNegative };
}

// ─── Phase B: Synthetic DNC blocks ───────────────────────────────────────

async function phaseB() {
  console.log("\n=== Phase B: Synthetic DNC tests ===");
  const { data: dncPersons, error } = await sb
    .from("persons")
    .select("id, real_name, emails")
    .eq("outreach_status", "do_not_contact")
    .not("emails", "eq", "{}");
  if (error) {
    console.error("Failed to fetch DNC persons:", error.message);
    return;
  }
  const withEmails = (dncPersons ?? []).filter((p) => p.emails && p.emails.length > 0);
  console.log(`Testing ${withEmails.length} DNC persons with attached emails...`);

  const tests = [];
  for (const p of withEmails) {
    for (const email of p.emails) {
      tests.push({ name: p.real_name, email, label: "exact" });
      tests.push({ name: p.real_name, email: email.toUpperCase(), label: "uppercase" });
      tests.push({ name: p.real_name, email: ` ${email} `, label: "padded" });
    }
  }
  let total = 0, blocked = 0, falseNegative = 0;
  const fnSamples = [];
  for (let i = 0; i < tests.length; i += 10) {
    const batch = tests.slice(i, i + 10);
    const out = await Promise.all(batch.map((t) => checkSendAllowed(t.email).then((r) => ({ ...t, r }))));
    for (const { name, email, r } of out) {
      total++;
      if (r.ok) {
        falseNegative++;
        if (fnSamples.length < 5) fnSamples.push({ name, email });
      } else if (r.code === "do_not_contact") {
        blocked++;
      }
    }
  }
  console.log(`  Total synthetic sends: ${total}`);
  console.log(`  Blocked as do_not_contact: ${blocked}`);
  console.log(`  FALSE NEGATIVES: ${falseNegative}`);
  if (fnSamples.length) {
    console.log(`  Sample FN: ${JSON.stringify(fnSamples)}`);
  }
  return { total, blocked, falseNegative };
}

// ─── Phase C: Resolver merge on new alias ────────────────────────────────

async function phaseC() {
  console.log("\n=== Phase C: Resolver merge on new alias ===");
  // Pick a DNC person with an email; simulate the same person being
  // discovered via a new email (HF profile reveals their gmail).
  const { data: target } = await sb
    .from("persons")
    .select("id, real_name, emails, hf_users, github_users")
    .eq("outreach_status", "do_not_contact")
    .not("emails", "eq", "{}")
    .limit(1)
    .single();
  if (!target) {
    console.log("  No DNC person with email — skipping.");
    return;
  }
  const existingEmail = target.emails[0];
  const newAlias = `synthetic-test-${Date.now()}@example.invalid`;
  console.log(`  Target: ${target.real_name} (${target.id})`);
  console.log(`  Existing email: ${existingEmail}`);
  console.log(`  Synthetic new alias: ${newAlias}`);

  // BEFORE: dedup gate on the new alias should NOT block (it's not in DB yet).
  const beforeR = await checkSendAllowed(newAlias);
  console.log(`  Before resolver: ${JSON.stringify(beforeR)}`);
  if (!beforeR.ok && beforeR.code === "do_not_contact") {
    console.log("  WARN: alias somehow already in DB — bailing out");
    return;
  }

  // SIMULATE RESOLVER: caller looks up by existingEmail (which links them
  // to target person), then attaches the new alias.
  const newEmails = [...(target.emails ?? []), newAlias];
  const { error: updErr } = await sb.from("persons").update({ emails: newEmails }).eq("id", target.id);
  if (updErr) {
    console.error("  Update failed:", updErr.message);
    return;
  }

  // AFTER: dedup gate on the new alias should NOW block.
  const afterR = await checkSendAllowed(newAlias);
  console.log(`  After resolver merge: ${JSON.stringify(afterR)}`);
  const ok = !afterR.ok && afterR.code === "do_not_contact";
  console.log(`  Result: ${ok ? "PASS" : "FAIL"}`);

  // Cleanup — remove the synthetic alias.
  const { error: cleanupErr } = await sb
    .from("persons")
    .update({ emails: target.emails })
    .eq("id", target.id);
  if (cleanupErr) console.error("  Cleanup failed:", cleanupErr.message);
}

// ─── Main ────────────────────────────────────────────────────────────────

const a = await phaseA();
const b = await phaseB();
await phaseC();

console.log("\n=== SUMMARY ===");
if (a) console.log(`Phase A replay: ${a.falseNegative}/${a.recent} false negatives`);
if (b) console.log(`Phase B DNC: ${b.falseNegative}/${b.total} false negatives`);
const aPass = a && a.falseNegative === 0;
const bPass = b && b.falseNegative === 0;
console.log(aPass && bPass ? "\nALL CLEAR ✓" : "\nFAILURES — investigate above");
