// Manually fire the heuristic-seed cron to backfill today's missions.
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke";
const mod = await import("/Users/xingzewang/Desktop/mail/src/app/api/missions/heuristic-seed/route.ts");
const req = new Request("http://localhost/api/missions/heuristic-seed", {
  headers: { authorization: "Bearer " + process.env.CRON_SECRET },
});
const res = await mod.GET(req);
const j = await res.json();
console.log("today:", j.today);
console.log("results:");
for (const r of j.results || []) {
  console.log("  rep", r.rep_id, r.rep_name + ":",
    "send=" + r.send_target,
    "reply=" + r.reply_target,
    r.skipped_reason ? "(SKIPPED: " + r.skipped_reason + ")" : "");
}
