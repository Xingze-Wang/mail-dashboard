/**
 * Template feature health snapshot.
 *
 * Run after the template-feature commits to check:
 *   - How many templates exist? Active vs proposal vs archived?
 *   - Has the congress proposal cron run? Did it produce anything?
 *   - What's the recent send mix — is template_id always being stamped?
 *   - Per-template last-30-day reply / wechat counts (sanity check that
 *     the bench's /api/templates/bench perf90d aggregation will have
 *     non-empty data when admin runs it)
 *
 * Per memory feedback_test_yourself.md, this verifies the deployed
 * template feature without asking the user to click around.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("=".repeat(70));
console.log("TEMPLATE FEATURE STATUS");
console.log("=".repeat(70));

// 1. All template rows
const { data: tpls } = await sb
  .from("email_templates")
  .select("id, name, rep_id, active, status, segment_default, proposed_by, proposed_reason, created_at")
  .order("created_at", { ascending: false });

console.log(`\n1. email_templates rows (${tpls?.length ?? 0} total):\n`);
const byStatus = { active: 0, proposal: 0, archived: 0 };
for (const t of tpls ?? []) {
  const seg = t.segment_default ? `seg=${t.segment_default}` : "(no seg)";
  const rep = t.rep_id ? `rep=${t.rep_id}` : "(global)";
  const prop = t.proposed_by ? ` ← ${t.proposed_by}` : "";
  const flag = t.status === "active" ? "✓" : t.status === "proposal" ? "⏳" : "▢";
  console.log(`  ${flag} ${t.status.padEnd(8)} ${t.name.padEnd(40)} ${rep.padEnd(12)} ${seg}${prop}`);
  byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
}
console.log(`\n   Summary: active=${byStatus.active}, proposal=${byStatus.proposal}, archived=${byStatus.archived}`);

// 2. Recent send mix — is template_id being stamped?
const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
const { count: total30 } = await sb
  .from("emails")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since30);
const { count: withTpl30 } = await sb
  .from("emails")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since30)
  .not("template_id", "is", null);

console.log(`\n2. Last 30 days send health:`);
console.log(`   Total emails sent: ${total30}`);
console.log(`   With template_id stamped: ${withTpl30} (${total30 ? ((withTpl30 / total30) * 100).toFixed(1) : 0}%)`);
if (total30 > 0 && withTpl30 / total30 < 0.95) {
  console.log(`   ⚠️ Stamping rate dropped — investigate /api/pipeline/send + batch-send`);
} else {
  console.log(`   ✓ Stamping rate healthy`);
}

// 3. Per-template send distribution (last 30d)
console.log(`\n3. Last 30 days per-template send count:`);
const { data: recentEmails } = await sb
  .from("emails")
  .select("template_id")
  .gte("created_at", since30)
  .not("template_id", "is", null);
const counts = new Map();
for (const e of recentEmails ?? []) {
  counts.set(e.template_id, (counts.get(e.template_id) ?? 0) + 1);
}
const tplName = new Map((tpls ?? []).map((t) => [t.id, t.name]));
const sortedCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [tid, n] of sortedCounts.slice(0, 10)) {
  console.log(`   ${String(n).padStart(5)}  ${tplName.get(tid) ?? `(deleted? ${tid.slice(0, 8)})`}`);
}

// 4. Has the template-proposals cron ever run?
console.log(`\n4. Congress template-proposals cron evidence:`);
const congressProposals = (tpls ?? []).filter((t) => t.proposed_by === "congress");
console.log(`   Templates with proposed_by='congress': ${congressProposals.length}`);
for (const p of congressProposals) {
  console.log(`     ⏳ ${p.name} (created ${p.created_at?.slice(0, 16)})`);
  if (p.proposed_reason) console.log(`        reason: ${p.proposed_reason.slice(0, 120)}`);
}
if (congressProposals.length === 0) {
  console.log(`   (Cron schedule is "45 1 * * 1" — Mondays only. If today is not Mon, this is normal.)`);
  const today = new Date().getUTCDay();
  console.log(`   Today UTC: ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][today]}`);
}

// 5. Override slot count (segment-aware variants)
const { count: overrideCount } = await sb
  .from("email_template_overrides")
  .select("*", { count: "exact", head: true });
console.log(`\n5. email_template_overrides rows: ${overrideCount}`);
if (overrideCount === 0) {
  console.log(`   No segment-aware variants yet. Bench can still surface template_default labels.`);
}

// 6. admin_inbox: any congress-led template proposals there?
const { data: inboxIdeas } = await sb
  .from("admin_inbox")
  .select("kind, headline, status, created_at")
  .eq("kind", "idea")
  .ilike("headline", "%Template proposal%")
  .order("created_at", { ascending: false })
  .limit(10);
console.log(`\n6. admin_inbox 'Template proposal' ideas: ${inboxIdeas?.length ?? 0}`);
for (const i of inboxIdeas ?? []) {
  console.log(`   ${i.status.padEnd(12)} ${i.headline?.slice(0, 80)}`);
}

console.log(`\n${"=".repeat(70)}\n`);
