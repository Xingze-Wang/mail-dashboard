// Attach the 4 verified emails recovered from the 15-agent DNC fan-out.
// 2 came from agents directly (杨林易, 修宇亮); 2 came from manual WebFetch
// recovery after agents flagged "identity confirmed but email blocked"
// (汤嘉斌 → jiabintang77@gmail.com, 胡越舟 → yuezhouhu@berkeley.edu).
//
// One low-confidence candidate (刘偲, 0.6 — fails 30d recency) goes to the
// person_enrichment_candidates table, NOT directly to persons.
//
// Usage: node scripts/agent-runs/dnc/attach-verified.mjs

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const VERIFIED = [
  {
    person_id: "8d7e3284-e2ee-4ad2-9706-39369f3c22a9",
    real_name: "杨林易",
    email: "yanglinyiucd@gmail.com",
    confidence: 0.9,
    affiliation: "Westlake University / SUSTech (Research Assistant Professor, GenAI Lab)",
    evidence: "Personal site yanglinyi.github.io carries '杨林易' + this email; 2026 PhD recruitment notice; ICLR/ACL 2025 AC. Source: agent-1.json",
  },
  {
    person_id: "a9ece1eb-7d3c-4e99-8ac6-3409aa4dc55e",
    real_name: "修宇亮",
    email: "xiuyuliang@westlake.edu.cn",
    confidence: 0.92,
    affiliation: "Westlake University (Assistant Professor, Endless AI Lab)",
    evidence: "Westlake faculty page lists Yuliang Xiu (修宇亮) with this email; personal site xiuyuliang.cn confirms char/pinyin pair; 2026 NeurIPS post + ICLR/CVPR AC roles. Source: agent-15.json",
  },
  {
    person_id: "a8ed0b34-6e1a-457d-b118-04a2a2a955bb",
    real_name: "汤嘉斌",
    email: "jiabintang77@gmail.com",
    confidence: 0.9,
    affiliation: "The University of Hong Kong (PhD student)",
    evidence: "Homepage tjb-tech.github.io Contact section lists this email; GitHub user tjb-tech (name='Jiabin Tang', company='HKU') confirms identity; AutoAgent/AI-Researcher/Kimi-Researcher contributor (2025-2026 active). Source: agent-1.json + manual WebFetch.",
  },
  {
    person_id: "cecab384-e462-4388-8e82-0c49ef911fbf",
    real_name: "胡越舟",
    email: "yuezhouhu@berkeley.edu",
    confidence: 0.9,
    affiliation: "UC Berkeley (incoming PhD; from Tsinghua CS)",
    evidence: "Homepage yuezhouhu.github.io About-me lists this email; GitHub yuezhouhu (name='Yuezhou Hu') confirms identity; AdaSPEC arXiv 2510.19779 (Oct 2025), NeurIPS 2025 spotlight. Source: agent-12.json + manual WebFetch.",
  },
];

const CANDIDATE = {
  person_id: "9978bda3-41eb-4435-adb5-b02ebfacff44",
  real_name: "刘偲",
  email: "liusi@buaa.edu.cn",
  confidence: 0.6,
  notes: "BUAA faculty page + Scholar + personal site all confirm identity, but latest verifiable activity is CVPR/AAAI 2025 — fails strict last-30-days recency rule. Keep as candidate; do NOT auto-attach to DNC record without recent-activity confirmation. Source: agent-6.json",
};

console.log(`Attaching ${VERIFIED.length} verified emails to DNC persons...\n`);

let attached = 0;
let alreadyHad = 0;
let failed = 0;

for (const v of VERIFIED) {
  const { data: row, error: readErr } = await sb
    .from("persons")
    .select("id, real_name, emails, outreach_status, bio")
    .eq("id", v.person_id)
    .single();
  if (readErr || !row) {
    console.log(`  ${v.real_name}: READ FAILED — ${readErr?.message}`);
    failed++;
    continue;
  }
  if (row.outreach_status !== "do_not_contact") {
    console.log(`  ${v.real_name}: WARNING — outreach_status='${row.outreach_status}' not 'do_not_contact' (proceeding)`);
  }
  const existing = row.emails || [];
  if (existing.includes(v.email)) {
    console.log(`  ${v.real_name}: already has ${v.email}; skipped`);
    alreadyHad++;
    continue;
  }
  const newEmails = [...existing, v.email];
  const evidenceLine = `\n[DNC verify ${new Date().toISOString().slice(0, 10)}, conf ${v.confidence}] ${v.email} — ${v.evidence}`;
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

console.log(`\nWriting low-confidence candidate to person_enrichment_candidates...`);
const { error: candErr } = await sb.from("person_enrichment_candidates").insert({
  person_id: CANDIDATE.person_id,
  field: "email",
  proposed_value: CANDIDATE.email,
  confidence: CANDIDATE.confidence,
  evidence: CANDIDATE.notes,
  source: "dnc-agent-6",
  status: "pending",
});
if (candErr) {
  console.log(`  ${CANDIDATE.real_name}: candidate write FAILED — ${candErr.message}`);
} else {
  console.log(`  ${CANDIDATE.real_name}: candidate row written (status=pending)`);
}

console.log(`\n=== Summary ===`);
console.log(`Attached: ${attached}`);
console.log(`Already had: ${alreadyHad}`);
console.log(`Failed: ${failed}`);
console.log(`Candidate (low-conf): 1`);
console.log(`Skip-fast (no email found): ${44 - VERIFIED.length - 1}/44`);
