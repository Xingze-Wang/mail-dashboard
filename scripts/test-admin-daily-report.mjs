/**
 * Smoke: buildAdminDailyReport produces a string with key sections.
 * Run: npx tsx --env-file=.env.local scripts/test-admin-daily-report.mjs
 */
let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

const { buildAdminDailyReport } = await import("../src/lib/admin-daily-report.ts");
const text = await buildAdminDailyReport();
console.log("\n--- RENDERED REPORT ---");
console.log(text);
console.log("--- END REPORT ---\n");
assert(typeof text === "string" && text.length > 100, "returns non-trivial string");
assert(text.includes("昨天"), "has '昨天' section");
assert(text.includes("本周累计") || text.includes("本周"), "has '本周' section");
assert(text.includes("按 rep 看") || text.includes("rep"), "has per-rep table");
assert(text.includes("怎么用 AI") || text.includes("AI"), "has AI-usage section");
assert(text.includes("需要你注意") || text.includes("注意"), "has alerts section");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
