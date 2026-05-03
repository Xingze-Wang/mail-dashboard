// JITR stop-loss + graduation sweep.
//
// For every accepted JITR offer, check the last N sends after applied_at:
//   - If >=30 sends with 0 opens AND 0 clicks → revert (per-rep template
//     deactivated for this rep, decision='reverted', DM the rep + admin)
//   - If 14+ days survived AND ≥50 sends with no revert → mark
//     promoted_global_at proposal so admin can promote org-wide
//
// Run: node scripts/jitr-stop-loss.mjs [--dry-run]
//
// Designed to run from cron daily. Idempotent — runs over jitr_offers
// where decision='accept' AND reverted_at IS NULL.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadDotenv(p) {
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {}
}
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv(resolve(here, "..", ".env.local"));
loadDotenv(resolve(here, "..", ".env"));

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
);

const DRY_RUN = process.argv.includes("--dry-run");
const STOP_LOSS_MIN_SENDS = 30; // need at least this many sends to evaluate
const GRADUATION_MIN_DAYS = 14;
const GRADUATION_MIN_SENDS = 50;

// ─── Lark sender (DM helper) ────────────────────────────────────────────
async function getLarkToken() {
  const base = process.env.LARK_REGION === "cn"
    ? "https://open.feishu.cn/open-apis"
    : "https://open.larksuite.com/open-apis";
  const res = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`token: ${JSON.stringify(j)}`);
  return { token: j.tenant_access_token, base };
}
async function dm({ token, base, openId, text }) {
  const res = await fetch(`${base}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) console.error("dm fail:", res.status, JSON.stringify(j).slice(0, 200));
}

// ─── Reps cache ─────────────────────────────────────────────────────────
const { data: reps } = await sb.from("sales_reps").select("id, name, lark_open_id");
const repById = new Map((reps ?? []).map((r) => [r.id, r]));
const adminRep = repById.get(5);

// ─── Sweep accepted, un-reverted offers ─────────────────────────────────
const { data: offers, error } = await sb
  .from("jitr_offers")
  .select("*")
  .eq("decision", "accept")
  .is("reverted_at", null)
  .is("promoted_global_at", null)
  .not("applied_at", "is", null);
if (error) { console.error(error.message); process.exit(1); }
console.log(`accepted offers under watch: ${offers.length}${DRY_RUN ? " (DRY RUN)" : ""}`);

const reverts = [];
const graduations = [];

for (const o of offers) {
  const rep = repById.get(o.rep_id);
  if (!rep) continue;

  // Count emails sent by this rep AFTER applied_at
  const { data: emails } = await sb
    .from("emails")
    .select("status, created_at, webhook_events(type)")
    .eq("rep_id", o.rep_id)
    .gte("created_at", o.applied_at);
  const sendCount = emails?.length ?? 0;
  const opens = (emails ?? []).filter((e) => e.status === "opened" || e.status === "clicked").length;
  const clicks = (emails ?? []).filter((e) => e.status === "clicked").length;
  const ageDays = (Date.now() - new Date(o.applied_at).getTime()) / (24 * 3600 * 1000);

  console.log(`  offer ${o.id.slice(0,8)} rep=${rep.name} sends=${sendCount} opens=${opens} clicks=${clicks} age=${ageDays.toFixed(1)}d`);

  // Stop-loss: ≥30 sends, 0 opens AND 0 clicks
  if (sendCount >= STOP_LOSS_MIN_SENDS && opens === 0 && clicks === 0) {
    reverts.push({ offer: o, rep, sendCount });
    continue;
  }
  // Graduation: ≥14 days AND ≥50 sends without revert
  if (ageDays >= GRADUATION_MIN_DAYS && sendCount >= GRADUATION_MIN_SENDS) {
    graduations.push({ offer: o, rep, sendCount, ageDays });
  }
}

console.log(`\nstop-loss reverts: ${reverts.length}, graduation candidates: ${graduations.length}`);

if (DRY_RUN) {
  for (const r of reverts) console.log(`  WOULD REVERT: ${r.rep.name} offer ${r.offer.id.slice(0,8)} (${r.sendCount} sends, 0 opens/clicks)`);
  for (const g of graduations) console.log(`  WOULD GRADUATE: ${g.rep.name} offer ${g.offer.id.slice(0,8)} (${g.sendCount} sends, ${g.ageDays.toFixed(1)}d)`);
  process.exit(0);
}

const { token, base } = await getLarkToken();

// Process reverts
for (const r of reverts) {
  const reason = `${r.sendCount} sends after apply; 0 opens AND 0 clicks → dead air`;
  // Mark offer reverted
  await sb.from("jitr_offers").update({
    decision: "reverted",
    reverted_at: new Date().toISOString(),
    reverted_reason: reason,
  }).eq("id", r.offer.id);
  // Deactivate the per-rep template (so global takes back over)
  await sb.from("email_templates").update({ active: false }).eq("rep_id", r.rep.id);
  // DM the rep
  if (r.rep.lark_open_id) {
    await dm({ token, base, openId: r.rep.lark_open_id, text:
      `📉 我把上次你接受的那个模板调整撤掉了 — 后面 ${r.sendCount} 封发出去 0 个打开 / 0 个点击, 看着不对劲. 已经回到默认模板. 如果你觉得是巧合, 也可以再让我加回来.`
    });
  }
  // DM admin
  if (adminRep?.lark_open_id) {
    await dm({ token, base, openId: adminRep.lark_open_id, text:
      `JITR auto-revert: ${r.rep.name}\n  pattern: "${r.offer.ai_phrase.slice(0,40)}…" → "${r.offer.sales_phrase.slice(0,40)}…"\n  reason: ${reason}`
    });
  }
  console.log(`  ✓ reverted ${r.rep.name} offer ${r.offer.id.slice(0,8)}`);
}

// Process graduations (admin proposal only — does NOT auto-promote)
for (const g of graduations) {
  await sb.from("jitr_offers").update({
    promoted_global_at: new Date().toISOString(),
  }).eq("id", g.offer.id);
  if (adminRep?.lark_open_id) {
    await dm({ token, base, openId: adminRep.lark_open_id, text:
      `🎓 JITR graduation candidate: ${g.rep.name}'s tweak survived ${g.sendCount} sends over ${g.ageDays.toFixed(0)} days, no stop-loss.\n  pattern: "${g.offer.ai_phrase.slice(0,40)}…" → "${g.offer.sales_phrase.slice(0,40)}…"\n  Want to promote to the global template? Reply YES to apply org-wide.`
    });
  }
  console.log(`  ✓ proposed graduation ${g.rep.name} offer ${g.offer.id.slice(0,8)}`);
}

console.log(`\nstop-loss sweep done. reverts=${reverts.length} graduations=${graduations.length}`);
