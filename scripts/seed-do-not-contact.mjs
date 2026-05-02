// Seed a list of people we should NOT contact, with no email yet.
// Creates a persons row with outreach_status='do_not_contact' for
// each name. If the resolver later finds an email match for any of
// these, dedup will refuse contact.
//
// Usage: node scripts/seed-do-not-contact.mjs

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const NAMES = [
  "杨林易", "阎栋", "汤嘉斌", "陈凯申", "张子尧", "年兴", "易和阳",
  "罗璇", "崔致豪", "杨吉凯", "胡叶凡", "赵梓合", "胡景皓", "秦成伟",
  "于佳辰", "许通达", "刘偲", "尹绪旺", "郭欣瑶", "任启涵", "李晓彤",
  "张子豪", "张金阳", "彭张扬", "张嘉琪", "邱生峰", "李升桂", "潘峰",
  "陈星宇", "胡晓彬", "宋鸿涌", "王洋", "那荣钰", "黄闻嵩", "杨硕",
  "胡越舟", "高俊", "张桂彬", "潘炜", "樊志文", "邹常青", "夏俊",
  "忻思阳", "修宇亮",
];

console.log(`Seeding ${NAMES.length} do-not-contact persons...\n`);

let created = 0;
let alreadyExists = 0;
let failed = 0;
const skipReasons = [];

for (const name of NAMES) {
  // Check if a person already exists with this real_name (avoid dups)
  const { data: existing } = await sb
    .from("persons")
    .select("id, real_name, outreach_status")
    .eq("real_name", name)
    .maybeSingle();
  if (existing) {
    alreadyExists++;
    // Make sure it's flagged DNC
    if (existing.outreach_status !== "do_not_contact") {
      await sb
        .from("persons")
        .update({ outreach_status: "do_not_contact" })
        .eq("id", existing.id);
      console.log(`  ${name}: already exists (id=${existing.id.slice(0, 8)}); flagged DNC`);
    } else {
      console.log(`  ${name}: already exists + already DNC; skipped`);
    }
    continue;
  }

  const { data: newP, error: insErr } = await sb
    .from("persons")
    .insert({
      real_name: name,
      outreach_status: "do_not_contact",
      bio: "Do-not-contact list (seeded 2026-04-30 by user request — internal team / known contact / explicit opt-out)",
    })
    .select("id")
    .single();

  if (insErr) {
    failed++;
    skipReasons.push(`${name}: ${insErr.message}`);
    continue;
  }
  created++;
  console.log(`  ${name}: created (id=${newP.id.slice(0, 8)})`);
}

console.log(`\n=== Summary ===`);
console.log(`Created: ${created}`);
console.log(`Already existed (re-flagged DNC if needed): ${alreadyExists}`);
console.log(`Failed: ${failed}`);
if (skipReasons.length) console.log(`Reasons: ${skipReasons.join("; ")}`);

// Verify all 44 are now DNC-flagged
const { data: verify } = await sb
  .from("persons")
  .select("real_name")
  .eq("outreach_status", "do_not_contact")
  .in("real_name", NAMES);
console.log(`\nVerification: ${verify?.length ?? 0}/${NAMES.length} now flagged do_not_contact`);
