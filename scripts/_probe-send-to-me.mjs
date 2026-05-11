// 直接调 sendMessage 给 Xingze (王幸泽), 打印 Lark 返回的完整错误.
// 看到底 200345 是什么 — receive_id 错了? token 失效? 还是 bot 没在该
// DM 里? 不重新触发 onboarding 卡, 只发一条朴素文字.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { sendMessage } = await import("/Users/xingzewang/Desktop/mail/src/lib/lark.ts");

const TARGET = "ou_395f934f5add3c398bed6be8f258246b"; // Xingze
console.log("→ POST /im/v1/messages?receive_id_type=open_id");
console.log("  receive_id:", TARGET);
const r = await sendMessage({
  receive_id: TARGET,
  receive_id_type: "open_id",
  text: "[probe] testing direct send. 如果你看见这条说明 sendMessage 通了.",
});
console.log("\nResult:", JSON.stringify(r, null, 2));
