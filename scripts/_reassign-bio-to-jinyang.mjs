// Reassign 50 newest bio-direction leads from Ethan (rep_id=3) to
// 李金阳 (rep_id=10). "Bio" = direction matches any of:
// 细胞分析算法 / 电镜数据分析模型 / 蛋白功能大模型 / 多肽药物发现 /
// RNA药物智能设计 / 物理偏置分子建模 / AI4S Agent / 化学材料大模型 /
// 原子级材料模型. Newest-first ordering.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const BIO_KEYWORDS = ["细胞分析算法","电镜数据分析模型","蛋白功能大模型","多肽药物发现","RNA药物智能设计","物理偏置分子建模","AI4S Agent","化学材料大模型","原子级材料模型"];

// Drain Ethan's leads
const all = [];
let from = 0;
while (true) {
  const { data, error } = await sb.from("pipeline_leads")
    .select("id, title, matched_directions, status, created_at")
    .eq("assigned_rep_id", 3)
    .range(from, from + 999);
  if (error) { console.error(error.message); break; }
  if (!data?.length) break;
  all.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}

// Filter to bio matches
const matches = [];
for (const l of all) {
  let dirs = l.matched_directions;
  if (typeof dirs === "string") { try { dirs = JSON.parse(dirs); } catch { dirs = [dirs]; } }
  if (!Array.isArray(dirs)) continue;
  if (dirs.some((d) => BIO_KEYWORDS.some((b) => d?.includes(b)))) matches.push(l);
}
matches.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
const targets = matches.slice(0, 50);
console.log(`Reassigning ${targets.length} newest bio leads from Ethan → 李金阳 (rep_id=10)...`);

let ok = 0, fail = 0;
for (const lead of targets) {
  const { error } = await sb.from("pipeline_leads").update({ assigned_rep_id: 10 }).eq("id", lead.id);
  if (error) { fail++; console.error(" fail", lead.id, error.message); }
  else { ok++; }
}
console.log(`DONE — ok=${ok} fail=${fail}`);
