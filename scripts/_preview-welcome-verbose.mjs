// 4 条 welcome 一条条发, 每条打 ok / error. 上次 _preview-welcome.mjs
// 调用了 sendWalkthrough 但没看返回值就报 Done — 用户看不到消息时
// 我没法判断到底是发出去了被覆盖, 还是某步崩了. 这次每条都验.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { sendMessage } = await import("/Users/xingzewang/Desktop/mail/src/lib/lark.ts");

const TARGET = "ou_395f934f5add3c398bed6be8f258246b";  // Xingze
const messages = [
  "幸泽, 欢迎 🎉\n\nAdmin 已经通过你的申请了 — 你正式是 算力组 的人了.",
  "Dashboard: https://calistamind.com\n登录邮箱: xingze@compute.miracleplus.com\n密码: 你刚才设的那个.\n\n核心 3 页面:\n  • /pipeline — lead\n  • /emails — 邮件追踪\n  • /inbox — 客户回信",
  "📚 资料合集 (admin 还没配, 这里跳过)",
  "怎么使唤我: 直接 DM 就行.\n第一周不用追求量, 把节奏感建起来就行. 明早北京时间 9 点左右我会再 DM 你.",
];

for (let i = 0; i < messages.length; i++) {
  const r = await sendMessage({ receive_id: TARGET, receive_id_type: "open_id", text: messages[i] });
  console.log(`msg ${i+1}/4: ${r.ok ? "ok msg_id=" + r.message_id : "FAIL " + r.error}`);
  if (!r.ok) break;
  await new Promise((s) => setTimeout(s, 600));  // small gap
}
