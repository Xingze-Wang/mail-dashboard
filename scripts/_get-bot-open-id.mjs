// One-shot: ask Lark for our bot's open_id and print it. Set
// LARK_BOT_OPEN_ID in .env.local + Vercel env to skip the runtime
// lookup. The bot's open_id is stable per app — fetch once forever.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { getBotOpenId } = await import("/Users/xingzewang/Desktop/mail/src/lib/lark.ts");
const id = await getBotOpenId();
if (id) console.log("LARK_BOT_OPEN_ID=" + id);
else console.log("FAILED — check LARK_APP_ID / LARK_APP_SECRET / LARK_REGION");
