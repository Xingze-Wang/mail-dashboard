import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke";
const mod = await import("/Users/xingzewang/Desktop/mail/src/app/api/cron/daily-rep-brief/route.ts");
const req = new Request("http://localhost/api/cron/daily-rep-brief", {
  headers: { authorization: "Bearer " + process.env.CRON_SECRET },
});
const res = await mod.GET(req);
const j = await res.json();
console.log("reps_processed:", j.reps_processed, "| failures:", j.failures, "| duration_ms:", j.duration_ms);
for (const r of (j.results || []).slice(0, 7)) {
  console.log("  rep", r.rep_id, "ok=" + r.ok, r.error ?? "");
}
