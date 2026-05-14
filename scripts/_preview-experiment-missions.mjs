// Dry-run preview of the Monday "experiment" mission generator.
// Runs buildExperimentMission for each active sales rep WITHOUT
// writing to the missions table, so admin can see what would land
// without actually shipping a mission row on a Tuesday.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const { computeSegmentFunnels } = await import("/Users/xingzewang/Desktop/mail/src/lib/segment-funnels.ts");

// Inline the same logic as buildExperimentMission for the preview.
async function buildExperimentMission(repId, repName) {
  const repFunnel = await computeSegmentFunnels({ repId, lookbackDays: 30 });
  if (repFunnel.totals.delivered < 20) return { skipped: "lowN", n: repFunnel.totals.delivered };

  const orgFunnel = await computeSegmentFunnels({ repId: null, lookbackDays: 30 });
  const orgCtr = orgFunnel.totals.delivered > 0
    ? orgFunnel.totals.clicked / orgFunnel.totals.delivered : 0.2;

  const candidates = [];
  for (const dim of repFunnel.dimensions) {
    if (!["geo_binary","direction","school_tier"].includes(dim.dimension)) continue;
    for (const seg of dim.segments) {
      if (seg.delivered < 10) continue;        // matches the production threshold
      if (seg.segment === "(no lead data)" || seg.segment === "(unknown)") continue;
      candidates.push({
        dimension: dim.dimension,
        segment: seg.segment,
        delta: seg.ctr - orgCtr,
        ctr: seg.ctr,
        n: seg.delivered,
      });
    }
  }
  if (candidates.length === 0) return { skipped: "no candidates" };
  candidates.sort((a, b) => b.delta - a.delta);
  const winner = candidates[0];
  if (winner.delta < 0.03) return { skipped: `top delta only ${(winner.delta*100).toFixed(1)}pp (<3pp)`, top: winner };

  const target = winner.delta >= 0.10 ? 15 : winner.delta >= 0.05 ? 10 : 6;
  return { winner, target, orgCtr };
}

const { data: reps } = await sb.from("sales_reps").select("id, name, role").eq("active", true).eq("role", "sales");
console.log(`Previewing weekly-experiment mission for ${reps.length} active sales reps:\n`);
for (const r of reps) {
  const out = await buildExperimentMission(r.id, r.name);
  console.log(`── ${r.name} (id=${r.id}) ──`);
  if (out.skipped) {
    console.log(`  SKIP: ${out.skipped}`);
    if (out.top) console.log(`  (best candidate was ${out.top.segment} +${(out.top.delta*100).toFixed(1)}pp)`);
  } else {
    console.log(`  → push ${out.target} more from "${out.winner.segment}" (${out.winner.dimension})`);
    console.log(`  CTR: rep ${(out.winner.ctr*100).toFixed(1)}% vs org ${(out.orgCtr*100).toFixed(1)}% (+${(out.winner.delta*100).toFixed(1)}pp) on n=${out.winner.n}`);
  }
  console.log();
}
