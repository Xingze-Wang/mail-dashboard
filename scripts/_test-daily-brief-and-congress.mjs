// Smoke: fire both new crons against prod data.
//   1. /api/cron/daily-rep-brief — writes daily_rep_brief rows
//   2. /api/cron/congress-topic-propose — proposes congress topics
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");

const briefMod = await import("/Users/xingzewang/Desktop/mail/src/app/api/cron/daily-rep-brief/route.ts");
const topicMod = await import("/Users/xingzewang/Desktop/mail/src/app/api/cron/congress-topic-propose/route.ts");

process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke-secret";
const auth = `Bearer ${process.env.CRON_SECRET}`;

console.log("[1/2] /api/cron/daily-rep-brief …");
const req1 = new Request("http://localhost/api/cron/daily-rep-brief", { headers: { authorization: auth } });
const res1 = await briefMod.GET(req1);
const j1 = await res1.json();
console.log("  reps_processed:", j1.reps_processed, "failures:", j1.failures, "duration_ms:", j1.duration_ms);
for (const r of (j1.results || []).slice(0, 5)) console.log("   rep_id=" + r.rep_id, "ok=" + r.ok, r.error || "");

console.log("\n[2/2] /api/cron/congress-topic-propose …");
const req2 = new Request("http://localhost/api/cron/congress-topic-propose", { headers: { authorization: auth } });
const res2 = await topicMod.GET(req2);
const j2 = await res2.json();
console.log("  ", JSON.stringify(j2, null, 2));

// Verify what landed
const today = new Date().toISOString().slice(0, 10);
const { data: briefs } = await supabase.from("daily_rep_brief").select("rep_id, goal").eq("brief_date", today);
console.log(`\nDaily briefs written for ${today}:`);
for (const b of briefs || []) console.log("   rep " + b.rep_id + ":", b.goal);

const { data: topics } = await supabase
  .from("congress_debate_proposals")
  .select("id, topic_title, status, for_congress_on, created_at")
  .order("created_at", { ascending: false })
  .limit(5);
console.log("\nRecent congress topics:");
for (const t of topics || []) console.log("   " + t.status + " — " + t.topic_title);
