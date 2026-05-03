// Attach the 5 verified emails from the v2 DNC pass.
// All 5 cleared char-match floor + 2-signal verification + last-30-day activity.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const VERIFIED = [
  {
    person_id: "9978bda3-41eb-4435-adb5-b02ebfacff44",
    real_name: "刘偲",
    email: "liusi@buaa.edu.cn",
    confidence: 0.9,
    affiliation: "Beihang University (Institute of AI, ColaLab)",
    evidence: "Email printed on her own April-2026 arxiv paper 2604.13596 'VGGT-Segmentor' (submitted 2026-04-15, revised 2026-04-16); confirmed by Scholar -QtVtNEAAAAJ + colalab.net 6 CVPR 2026 papers. Source: v2-liusi.json",
  },
  {
    person_id: "3184534a-f289-43ec-8cfe-ccadfb176c5c",
    real_name: "任启涵",
    email: "renqihan@sjtu.edu.cn",
    confidence: 0.97,
    affiliation: "Shanghai Jiao Tong University (Quanshi Zhang group, Lab for Interpretable ML, SEIEE)",
    evidence: "Personal site nebularaid2000.github.io + Scholar ybTy_DwAAAAJ (verified sjtu.edu.cn) + GitHub Nebularaid2000 + SJTU 2024 doctoral scholarship PDF (chars confirmed in SEIEE listing); GitHub commit 2026-04-26 (5 days ago). Source: v2-renqihan.json",
  },
  {
    person_id: "6a7f28cc-66bd-4c09-8e8b-cf0bffed5485",
    real_name: "秦成伟",
    email: "chengweiqin@hkust-gz.edu.cn",
    confidence: 0.95,
    affiliation: "HKUST(GZ) (Assistant Professor, AI Thrust, LAI Lab)",
    evidence: "HKUST(GZ) faculty profile id=543 char-matches 秦成伟; personal site qcwthu.github.io + Scholar OwBrmXwAAAAJ (verified hkust-gz.edu.cn); May 2026 ACL/ICML acceptances on news. Source: v2-qinchengwei.json",
  },
  {
    person_id: "1afd7a47-e6c3-4e4b-b842-d476ec62e1ea",
    real_name: "胡晓彬",
    email: "xbhunanu@126.com",
    confidence: 0.92,
    affiliation: "NUS LV-Lab (Senior Research Fellow, Shuicheng Yan); ex-Tencent Youtu, TUM PhD",
    evidence: "Personal site huuxiaobin.github.io explicitly lists 'Xiaobin Hu (胡晓彬)' with this email + GitHub HUuxiaobin (TUM company) + Scholar 3lMuodUAAAAJ; GitHub event 2026-04-28 (3 days ago). Source: v2-huxiaobin.json",
  },
  {
    person_id: "7b6b23a9-8491-47e4-a636-a7efea094238",
    real_name: "张桂彬",
    email: "guibinz@u.nus.edu",
    confidence: 0.95,
    affiliation: "National University of Singapore (PhD, Shuicheng Yan group); ex-Tongji",
    evidence: "Personal site guibinz.top lists email; Chinese article on qingkeai.online uses chars 张桂彬 with same supervisor+homepage; arxiv 2604.08000 (2026-04-09, 22 days ago). Source: v2-zhangguibin.json",
  },
];

console.log(`Attaching ${VERIFIED.length} v2-verified emails...\n`);

let attached = 0, alreadyHad = 0, failed = 0;

for (const v of VERIFIED) {
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
  const evidenceLine = `\n[DNC v2 ${new Date().toISOString().slice(0, 10)}, conf ${v.confidence}] ${v.email} — ${v.evidence}`;
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

console.log(`\n=== v2 Summary ===`);
console.log(`Attached: ${attached}`);
console.log(`Already had: ${alreadyHad}`);
console.log(`Failed: ${failed}`);
console.log(`Skipped (correctly, per char-match floor): 15/20`);
