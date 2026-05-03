// Attach the 3 "identity-locked, no char source" cases the user authorized.
// These are cases where v2 agents fully identified the person via 2+ signals
// in a non-Chinese-language paper trail; the only thing missing was a char-bearing
// source. User has confirmed the disambiguation, so under-attach is the worse error.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const LOCKED = [
  {
    person_id: "19031aa3-607d-4f49-94aa-df74a08a878d",
    real_name: "杨硕",
    email: "andy_yang@berkeley.edu",
    confidence: 0.9,
    affiliation: "UC Berkeley EECS PhD (Sky Computing Lab, advisor Ion Stoica); ex-SJTU ACM Honors Class 2020-2024",
    evidence: "User-confirmed Berkeley match; identity locked via personal site andy-yang-1.github.io + GitHub andy-yang-1 + Sky Lab people page + OpenReview ~Shuo_Yang22 + Scholar tJpoCUIAAAAJ (verified berkeley.edu) + BlendServe ASPLOS 2026 + NeurIPS 2025 Spotlight x2 + Amazon AI PhD Fellowship 2025. No Chinese-char source publicly pairs 杨硕 to this Berkeley identity, but user authorized disambiguation.",
  },
  {
    person_id: "c7fff4c8-be8b-4152-a186-40720fe4b086",
    real_name: "许通达",
    email: "x.tongda@nyu.edu",
    confidence: 0.85,
    affiliation: "Tsinghua AIR PhD (advisor Ya-Qin Zhang); ex-NYU MS, Cambridge visiting (Hernández-Lobato), Zhipu AI/MSRA/SenseTime intern",
    evidence: "Identity locked via personal site tongdaxu.github.io + GitHub tongdaxu + Scholar LO8GS7sAAAAJ (verified air.tsinghua.edu.cn) + OpenReview Tongda_Xu1 + ICLR 2026 SenseFlow + CVPR25 PICD. The only competing 'Tongda Xu' is at FAFU (plant biology, clearly different person). No Chinese-char source disambiguates 许 vs 徐, but user authorized.",
  },
  {
    person_id: "40bd3d3d-9202-4200-9499-108615fdc95c",
    real_name: "宋鸿涌",
    email: "floodsung@gmail.com",
    confidence: 0.9,
    affiliation: "XVI Robotics (CEO); ex-Moonshot AI (lead RL on Kimi k1.5), ex-ByteDance, NUDT alumnus",
    evidence: "Pinyin 'Hongyong Song' uniquely points to this person. Identity locked via OpenReview ~Hongyong_Song1 sharing Scholar URL s11zFYQAAAAJ with ~Flood_Sung1 (= Flood Sung) + GitHub floodsung (xvirobotics.com company) + personal site floodsung.github.io + 2017 NUDT IEEE paper authored by Hongyong Song with email songrotek@gmail.com + ORCID 0009-0001-8261-4238. GitHub event 2026-04-21 (10 days ago).",
  },
];

console.log(`Attaching ${LOCKED.length} identity-locked emails (user-authorized)...\n`);

let attached = 0, alreadyHad = 0, failed = 0;

for (const v of LOCKED) {
  const { data: row, error: readErr } = await sb
    .from("persons")
    .select("id, real_name, emails, outreach_status, bio, affiliation")
    .eq("id", v.person_id)
    .single();
  if (readErr || !row) {
    console.log(`  ${v.real_name}: READ FAILED — ${readErr?.message}`);
    failed++;
    continue;
  }
  const existing = row.emails || [];
  if (existing.includes(v.email)) {
    console.log(`  ${v.real_name}: already has ${v.email}; skipped`);
    alreadyHad++;
    continue;
  }
  const newEmails = [...existing, v.email];
  const evidenceLine = `\n[DNC locked ${new Date().toISOString().slice(0, 10)}, conf ${v.confidence}, user-auth] ${v.email} — ${v.evidence}`;
  const newBio = (row.bio || "") + evidenceLine;
  const update = { emails: newEmails, bio: newBio };
  if (!row.affiliation && v.affiliation) update.affiliation = v.affiliation;

  const { error: updErr } = await sb
    .from("persons")
    .update(update)
    .eq("id", v.person_id);
  if (updErr) {
    console.log(`  ${v.real_name}: WRITE FAILED — ${updErr.message}`);
    failed++;
    continue;
  }
  console.log(`  ${v.real_name}: attached ${v.email} (conf ${v.confidence})`);
  attached++;
}

console.log(`\n=== Locked-attach Summary ===`);
console.log(`Attached: ${attached}`);
console.log(`Already had: ${alreadyHad}`);
console.log(`Failed: ${failed}`);
