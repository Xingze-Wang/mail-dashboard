/**
 * Smoke test the auto-promote cron logic. Mirrors the route's
 * grouping (rep_id OR segment_default) and Wilson CI gating, so the
 * output here is a faithful preview of what the cron decides at
 * 5:00 UTC every day.
 *
 * Won't actually mutate anything — just shows what would happen.
 */
import { supabase } from "../src/lib/db";

const MIN_SAMPLE = 30;

function wilsonCI(clicked: number, sent: number, z = 1.96): [number, number] {
  if (sent === 0) return [0, 1];
  const p = clicked / sent;
  const denom = 1 + (z * z) / sent;
  const center = (p + (z * z) / (2 * sent)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / sent + (z * z) / (4 * sent * sent))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

interface Bucket {
  id: string;
  name: string;
  status: string;
  segment: string | null;
  rep_id: number | null;
  sent: number;
  clicked: number;
}

function groupKey(b: Bucket): string {
  if (b.rep_id != null) return `rep:${b.rep_id}`;
  return `seg:${b.segment ?? "__GLOBAL__"}`;
}

async function main() {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data: tpls } = await supabase
    .from("email_templates")
    .select("id, name, status, segment_default, rep_id")
    .in("status", ["active", "approved_draft", "proposal"])
    .eq("active", true);
  console.log(`Found ${tpls?.length ?? 0} eligible templates`);
  if (!tpls || tpls.length === 0) return;

  const tplIds = tpls.map((t) => t.id as string);
  const { data: emails } = await supabase
    .from("emails")
    .select("id, template_id")
    .gte("created_at", since30)
    .in("template_id", tplIds);

  // Click signal
  const ids = (emails ?? []).map((e) => e.id as string);
  const clickedSet = new Set<string>();
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data: clicks } = await supabase
      .from("email_history")
      .select("email_id")
      .in("email_id", chunk)
      .eq("was_clicked", true);
    for (const c of clicks ?? []) clickedSet.add(c.email_id as string);
  }
  console.log(`${emails?.length ?? 0} sends in last 30d, ${clickedSet.size} clicks`);

  const buckets = new Map<string, Bucket>();
  for (const t of tpls) {
    buckets.set(t.id as string, {
      id: t.id as string,
      name: t.name as string,
      status: t.status as string,
      segment: (t.segment_default as string | null) ?? null,
      rep_id: (t.rep_id as number | null) ?? null,
      sent: 0,
      clicked: 0,
    });
  }
  for (const e of emails ?? []) {
    const b = buckets.get(e.template_id as string);
    if (!b) continue;
    b.sent++;
    if (clickedSet.has(e.id as string)) b.clicked++;
  }

  console.log("\nPer-template send counts:");
  for (const b of buckets.values()) {
    const flag = b.sent >= MIN_SAMPLE ? "✓" : "✗";
    const scope = b.rep_id != null ? `rep#${b.rep_id}` : (b.segment ?? "global");
    console.log(`  ${flag} ${b.status.padEnd(15)} ${b.name.padEnd(50)} ${scope.padEnd(12)} sent=${b.sent} clicks=${b.clicked}`);
  }

  // Group by composite key (matches the cron's groupKey logic)
  const grouped = new Map<string, Bucket[]>();
  for (const b of buckets.values()) {
    const k = groupKey(b);
    grouped.set(k, [...(grouped.get(k) ?? []), b]);
  }

  console.log("\nBy group (rep_id OR segment_default):");
  for (const [key, list] of grouped) {
    const active = list.find((t) => t.status === "active");
    const draft = list.find((t) => t.status === "approved_draft");
    const proposals = list.filter((t) => t.status === "proposal");
    console.log(`  ${key}: active=${!!active} approved_draft=${!!draft} proposals=${proposals.length}`);
    if (active && draft && active.sent >= MIN_SAMPLE && draft.sent >= MIN_SAMPLE) {
      const [aLow, aHigh] = wilsonCI(active.clicked, active.sent);
      const [dLow, dHigh] = wilsonCI(draft.clicked, draft.sent);
      const promote = dLow > aHigh;
      const refute = dHigh < aLow;
      const verdict = promote ? "PROMOTE draft" : refute ? "ARCHIVE draft (refuted)" : "no_op (CIs overlap)";
      console.log(
        `    Wilson 95% CI: active [${(aLow * 100).toFixed(1)}%, ${(aHigh * 100).toFixed(1)}%], ` +
        `draft [${(dLow * 100).toFixed(1)}%, ${(dHigh * 100).toFixed(1)}%]`,
      );
      console.log(`    → ${verdict}`);
    }
  }
  console.log("\nLogic loads cleanly.");
}
main().catch((e) => { console.error(e); process.exit(1); });
