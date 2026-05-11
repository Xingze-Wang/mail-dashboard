// Approve 李金阳 onboarding as senior. Calls processOnboardingCardAction
// with a synthetic event so the production code path runs verbatim —
// no DB hand-edits, no missed side-effects.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { processOnboardingCardAction } = await import("/Users/xingzewang/Desktop/mail/src/lib/onboarding.ts");

const synthetic = {
  event: {
    operator: { open_id: "ou_395f934f5add3c398bed6be8f258246b" },  // Xingze
    action: {
      value: {
        onboarding_action: "approve_senior",
        pending_id: "c2947dfd-1f0d-4968-8f29-745a6aff933c",   // 李金阳
      },
    },
  },
};

console.log("Approving 李金阳 as senior...");
const result = await processOnboardingCardAction(synthetic);
console.log("Result:", result);
