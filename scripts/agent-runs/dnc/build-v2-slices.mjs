// Build v2 slice files for the second-pass DNC dispatch.
// Pulls person_id for each remaining name and writes slice-v2-{name}.json.

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Targets: 20 remaining names after the 4 already attached + the 4 the user
// gave specific hints on. Including v1-skipped commons because v2 has the
// char-match-floor rule and may catch what v1 over-skipped.
const TARGETS = [
  // user gave specific institutional hints — high prior on these
  { name: "杨硕", hint: "UC Berkeley (incoming/current PhD; NOT the Shenzhen MSU-BIT prof — different person same chars)" },
  { name: "尹绪旺", hint: "Tsinghua University → Cambridge (NOT the Dalian Ocean U marine biologist; NOT the UVA AI safety guy)" },
  { name: "崔致豪", hint: "AI/CS researcher; agent-3 surfaced Zhi-Hao Cui (Caltech→Columbia→UC Irvine) as a candidate but couldn't char-confirm 致豪. Try harder — check his personal site, group pages, papers for the chars." },
  { name: "刘偲", hint: "BUAA Institute of AI prof; agent-6 confirmed identity. Just need to check 30d activity (April 2026 talks/papers/news) — if active, attach liusi@buaa.edu.cn." },

  // v1 commons — try v2 with char-match floor; some may have findable footprints
  { name: "胡景皓", hint: null },
  { name: "秦成伟", hint: null },
  { name: "于佳辰", hint: null },
  { name: "许通达", hint: null },
  { name: "郭欣瑶", hint: null },
  { name: "任启涵", hint: null },
  { name: "李晓彤", hint: null },
  { name: "潘峰", hint: null },
  { name: "陈星宇", hint: null },
  { name: "胡晓彬", hint: null },
  { name: "宋鸿涌", hint: null },
  { name: "那荣钰", hint: null },
  { name: "黄闻嵩", hint: null },
  { name: "张桂彬", hint: null },
  { name: "潘炜", hint: null },
  { name: "邱生峰", hint: null },
];

const slices = [];
for (const t of TARGETS) {
  const { data: p } = await sb
    .from("persons")
    .select("id, real_name, emails")
    .eq("real_name", t.name)
    .maybeSingle();
  if (!p) {
    console.log(`MISSING in db: ${t.name}`);
    continue;
  }
  if (p.emails && p.emails.length > 0) {
    console.log(`SKIP (already has email): ${t.name} → ${p.emails.join(", ")}`);
    continue;
  }
  slices.push({ person_id: p.id, real_name: p.real_name, hint: t.hint });
}

console.log(`\nWriting ${slices.length} v2 slice files...`);
for (const s of slices) {
  const safe = s.person_id.slice(0, 8);
  const path = `/Users/xingzewang/Desktop/mail/scripts/agent-runs/dnc/slice-v2-${safe}.json`;
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  console.log(`  ${s.real_name} → slice-v2-${safe}.json`);
}
