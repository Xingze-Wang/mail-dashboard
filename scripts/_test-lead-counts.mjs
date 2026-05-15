import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { runReadTool } = await import("/Users/xingzewang/Desktop/mail/src/lib/helper-read-tools.ts");
const session = { repId: 5, role: "admin", repName: "Xingze", email: "x@e.com" };

console.log("all (7d):");
const r1 = await runReadTool(session, { tool: "get_lead_counts", args: { since_days: 7 } });
console.log(JSON.stringify(r1.result, null, 2));

console.log("\ncn (7d):");
const r2 = await runReadTool(session, { tool: "get_lead_counts", args: { since_days: 7, geo: "cn" } });
console.log("  total=" + r2.result.total + " unassigned=" + r2.result.unassigned);

console.log("\nall (30d):");
const r3 = await runReadTool(session, { tool: "get_lead_counts", args: { since_days: 30 } });
console.log("  total=" + r3.result.total + " per_rep top 3:", r3.result.per_rep.slice(0, 3));
