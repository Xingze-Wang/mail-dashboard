// What did Leon receive recently, and what tools did it call?
// helper_messages stores user side, lark_messages stores raw Lark
// payloads, helper_conversations links it together.
import { config } from "dotenv";
config({ path: "/tmp/.vercel.env" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/"/g, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/"/g, "");
const sb = createClient(url, key, { auth: { persistSession: false } });

const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

console.log("=== last 3h on lark_messages ===");
const { data: lm } = await sb
  .from("lark_messages")
  .select("id, role, text, created_at, rep_id")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(30);
for (const r of lm || []) {
  const t = (r.text || "").slice(0, 100).replace(/\n/g, " ⏎ ");
  console.log(`[${r.created_at.slice(11, 19)}] role=${r.role} rep=${r.rep_id ?? "-"}: ${t}`);
}

console.log("\n=== last 3h on helper_messages (assistant-side empty by design) ===");
const { data: hm } = await sb
  .from("helper_messages")
  .select("id, role, text, conversation_id, created_at, tool_proposal")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(30);
for (const r of hm || []) {
  const t = (r.text || "").slice(0, 100).replace(/\n/g, " ⏎ ");
  const tp = r.tool_proposal ? ` [tool: ${JSON.stringify(r.tool_proposal).slice(0, 80)}]` : "";
  console.log(`[${r.created_at.slice(11, 19)}] role=${r.role}: ${t}${tp}`);
}

console.log("\n=== worker log tail ===");
import { readFileSync, readdirSync } from "node:fs";
const logs = readdirSync("/tmp/lark-worker").filter(n => !n.startsWith("supervisor")).sort();
const latest = "/tmp/lark-worker/" + logs[logs.length - 1];
const content = readFileSync(latest, "utf8").split("\n");
console.log("file:", latest);
console.log(content.slice(-30).join("\n"));
