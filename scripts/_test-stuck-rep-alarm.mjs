// Dry-run check: who would the stuck-rep-alarm DM today, without actually DM'ing.
// Just computes the team overview, lists alarmable reps, and checks cooldown.
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { computeTeamOverview } = await import("/Users/xingzewang/Desktop/mail/src/app/api/admin/team-overview/route.ts");
const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");

const overview = await computeTeamOverview();
console.log("Team overview snapshot (" + overview.today + "):");
console.log("  total reps:", overview.reps.length);

const byHealth = { stuck: [], watch: [], healthy: [] };
for (const r of overview.reps) byHealth[r.health].push(r);
console.log("  stuck:", byHealth.stuck.length, "| watch:", byHealth.watch.length, "| healthy:", byHealth.healthy.length);

console.log("\nWho would get alarmed:");
for (const r of [...byHealth.stuck, ...byHealth.watch]) {
  console.log(
    "  " + (r.health === "stuck" ? "🔴" : "🟡"),
    r.rep_name,
    "(" + r.rep_id + "):",
    r.health_reason,
    "| ready=" + r.ready_queue,
    "sends_7d=" + r.sent_7d,
    "missions=" + r.missions_done + "/" + r.missions_total,
  );
}

// Cooldown check
const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
const { data: chimes } = await supabase
  .from("helper_chime_in_log")
  .select("rep_id, sent_at, kind")
  .eq("kind", "stuck_rep_alarm")
  .gte("sent_at", since);
console.log("\nReps cooled down (alarmed in last 48h):", (chimes || []).map((c) => c.rep_id));
