// scripts/apply-038.mjs
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(__dirname, "../migrations/038-bench-sim.sql"), "utf8");

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY"); process.exit(1); }

const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
  body: JSON.stringify({ sql }),
});

if (!res.ok) {
  // Fallback: use the SQL editor endpoint
  const res2 = await fetch(`${url}/rest/v1/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, "Prefer": "return=minimal" },
    body: sql,
  });
  if (!res2.ok) { console.error("Migration failed", await res2.text()); process.exit(1); }
}
console.log("Migration 038 applied.");
