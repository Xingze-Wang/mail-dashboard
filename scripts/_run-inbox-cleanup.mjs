import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke";
const mod = await import("/Users/xingzewang/Desktop/mail/src/app/api/cron/inbox-auto-archive/route.ts");
const r = await mod.GET(new Request("http://localhost/api/cron/inbox-auto-archive", {
  headers: { authorization: "Bearer " + process.env.CRON_SECRET },
}));
console.log(await r.json());
