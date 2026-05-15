// Verify /api/pipeline/analytics no longer caps totalLeads at 1000.
// Calls computeAnalytics by invoking the route GET handler with a
// synthesized admin session.
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

// Mint admin JWT
const { SignJWT } = await import("jose");
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
const token = await new SignJWT({ repId: 5, role: "admin", repName: "Smoke", email: "smoke@e.com" })
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("1h")
  .sign(secret);

const mod = await import("/Users/xingzewang/Desktop/mail/src/app/api/pipeline/analytics/route.ts");
const { NextRequest } = await import("next/server");
const req = new NextRequest("http://localhost/api/pipeline/analytics", {
  headers: { cookie: `qiji_session=${token}` },
});
const res = await mod.GET(req);
const j = await res.json();
const ch = j.channels || {};
console.log("totalLeads (should be 3068+):", ch.totalLeads);
console.log("strongLeads:", ch.strongLeads);
console.log("sentLeads:", ch.sentLeads);
console.log("leadsThisWeek:", ch.leadsThisWeek);
console.log("wechatCount:", ch.wechatCount);
console.log("conversionRate:", ch.conversionRate, "%");
console.log("avgHIndex:", ch.avgHIndex);
console.log("sources keys:", Object.keys(ch.sources || {}));
console.log("\nper-rep assigned counts:");
for (const r of (j.sales?.reps || [])) {
  console.log("  " + r.rep.name + ": assigned=" + r.assigned + " sent=" + r.sent + " wechat=" + r.wechat);
}
