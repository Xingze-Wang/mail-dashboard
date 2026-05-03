// JITR — Just-In-Time Rep Ratifier.
//
// One tick: find pending drift patterns, figure out which rep mostly
// caused them, send each affected rep a Lark interactive card asking
// "yes or no?", record the offer in jitr_offers for idempotency.
// Notify admin (Xingze, rep_id=5) of what was sent.
//
// Run manually: node scripts/jitr-tick.mjs
// Run from cron: GET /api/jitr/tick (with CRON_SECRET) — TODO
//
// Decisions are processed by the Lark webhook / WS worker via the
// card.action.trigger_v1 event. See src/lib/lark-agent.ts for handler.
//
// SAFETY:
// - We never offer the same pattern to the same rep within 14 days
//   (idempotency via jitr_offers index).
// - We never offer a pattern to a rep who isn't bound on Lark
//   (lark_open_id IS NULL); admin sees those in the digest.
// - We only auto-attribute a rep when they own >= 60% of the
//   example_lead_ids; ambiguous patterns go to admin only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function loadDotenv(p) {
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {}
}
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv(resolve(here, "..", ".env.local"));
loadDotenv(resolve(here, "..", ".env"));

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const ADMIN_REP_ID = 5; // Xingze
const ATTRIBUTION_THRESHOLD = 0.6; // rep needs to own ≥60% of examples
const REOFFER_DAYS = 14; // don't re-offer same (pattern, rep) within this window
const DRY_RUN = process.argv.includes("--dry-run");

// ─── Lark token (cached in-memory for this run) ─────────────────────────
async function getLarkToken() {
  const appId = process.env.LARK_APP_ID;
  const secret = process.env.LARK_APP_SECRET;
  if (!appId || !secret) throw new Error("LARK_APP_ID / LARK_APP_SECRET missing");
  const base = process.env.LARK_REGION === "cn"
    ? "https://open.feishu.cn/open-apis"
    : "https://open.larksuite.com/open-apis";
  const res = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: secret }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`token: ${JSON.stringify(j)}`);
  return { token: j.tenant_access_token, base };
}

// ─── Send an interactive card to a Lark user (DM) ───────────────────────
async function sendJitrCard({ token, base, openId, pattern, repName }) {
  // Lark interactive card with two buttons. Action callbacks include
  // `value` which we use to look up the jitr_offers row server-side.
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `📝 一个小调整想法 - ${repName}`, tag: "plain_text" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `早. 我注意到最近 **${pattern.occurrence_count} 次** 你把这段:\n\n> ${pattern.ai_phrase}\n\n改成了这样:\n\n> ${pattern.sales_phrase}\n\n我可以把这条规则只加到 **你自己** 的草稿模板里, 以后自动这样写. 别的 rep 不受影响.`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "好, 加到我的模板" },
            type: "primary",
            value: { jitr_action: "accept", offer_id: pattern.__offer_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "算了, 那次是临时" },
            type: "default",
            value: { jitr_action: "dismiss", offer_id: pattern.__offer_id },
          },
        ],
      },
      {
        tag: "note",
        elements: [
          { tag: "plain_text", content: "如果加了之后效果不好, 系统会自动回滚 + 通知你." },
        ],
      },
    ],
  };
  const res = await fetch(`${base}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) throw new Error(`sendCard: ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return { message_id: j.data?.message_id };
}

async function sendDigestText({ token, base, openId, text }) {
  const res = await fetch(`${base}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) console.error("digest send failed:", res.status, JSON.stringify(j).slice(0, 200));
}

// ─── Main ───────────────────────────────────────────────────────────────
console.log(`JITR tick starting${DRY_RUN ? " (DRY RUN — no Lark sends, no DB writes)" : ""}`);

// 1. Pending patterns
const { data: patterns, error: pErr } = await sb
  .from("prompt_drift_patterns")
  .select("*")
  .eq("status", "pending")
  .gte("occurrence_count", 2)
  .order("occurrence_count", { ascending: false });
if (pErr) { console.error("pattern fetch:", pErr.message); process.exit(1); }
console.log(`pending patterns >=2 occurrences: ${patterns.length}`);

// 2. Reps + lark bindings
const { data: reps } = await sb.from("sales_reps").select("id, name, lark_open_id, active").eq("active", true);
const repById = new Map((reps ?? []).map((r) => [r.id, r]));
const adminRep = repById.get(ADMIN_REP_ID);

// 3. For each pattern: attribute to dominant rep
const offered = []; // { pattern, rep, openId, sent }
const skipped = []; // { pattern, reason }
const unboundReps = new Set();

for (const p of patterns) {
  const exampleIds = (p.example_lead_ids || []).filter((s) => typeof s === "string" && s.length > 0);
  if (exampleIds.length === 0) {
    skipped.push({ pattern: p, reason: "no example_lead_ids" });
    continue;
  }
  // example_lead_ids is mixed-format (some 8-char prefixes, some full UUIDs).
  // For each, try `eq` on full UUID; if not, fall back to `like`.
  const fullIds = exampleIds.filter((s) => s.length >= 36);
  const prefixIds = exampleIds.filter((s) => s.length < 36);
  const repCounts = new Map();
  if (fullIds.length > 0) {
    const { data: leadsFull } = await sb.from("pipeline_leads").select("assigned_rep_id").in("id", fullIds);
    for (const l of leadsFull ?? []) {
      if (l.assigned_rep_id == null) continue;
      repCounts.set(l.assigned_rep_id, (repCounts.get(l.assigned_rep_id) ?? 0) + 1);
    }
  }
  for (const prefix of prefixIds) {
    const { data: leadsPfx } = await sb.from("pipeline_leads").select("assigned_rep_id").like("id", `${prefix}%`).limit(5);
    for (const l of leadsPfx ?? []) {
      if (l.assigned_rep_id == null) continue;
      repCounts.set(l.assigned_rep_id, (repCounts.get(l.assigned_rep_id) ?? 0) + 1);
    }
  }
  const total = [...repCounts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) {
    skipped.push({ pattern: p, reason: "no leads resolvable from example_lead_ids" });
    continue;
  }
  const sorted = [...repCounts.entries()].sort((a, b) => b[1] - a[1]);
  const [topRepId, topCount] = sorted[0];
  if (topCount / total < ATTRIBUTION_THRESHOLD) {
    skipped.push({ pattern: p, reason: `multi-rep pattern (top ${topCount}/${total} = ${Math.round(100*topCount/total)}%); admin-review only` });
    continue;
  }
  const rep = repById.get(topRepId);
  if (!rep) {
    skipped.push({ pattern: p, reason: `rep_id=${topRepId} not found / not active` });
    continue;
  }
  if (!rep.lark_open_id) {
    unboundReps.add(rep.name);
    skipped.push({ pattern: p, reason: `${rep.name} not bound to Lark` });
    continue;
  }

  // Idempotency: skip if we've offered this pattern to this rep within REOFFER_DAYS
  const cutoff = new Date(Date.now() - REOFFER_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: priorOffers } = await sb
    .from("jitr_offers")
    .select("id, decision, offered_at")
    .eq("pattern_id", p.id)
    .eq("rep_id", rep.id)
    .gte("offered_at", cutoff)
    .order("offered_at", { ascending: false })
    .limit(1);
  if (priorOffers && priorOffers.length > 0) {
    skipped.push({ pattern: p, reason: `already offered to ${rep.name} on ${priorOffers[0].offered_at?.slice(0,10)} (decision=${priorOffers[0].decision})` });
    continue;
  }

  offered.push({ pattern: p, rep, openId: rep.lark_open_id });
}

console.log(`will offer: ${offered.length}, skip: ${skipped.length}, unbound reps: ${[...unboundReps].join(", ") || "none"}`);

if (DRY_RUN) {
  console.log("\nWould offer:");
  for (const o of offered) console.log(`  pattern ${o.pattern.id} → ${o.rep.name}: "${o.pattern.ai_phrase.slice(0,40)}" → "${o.pattern.sales_phrase.slice(0,40)}"`);
  console.log("\nWould skip:");
  for (const s of skipped.slice(0, 10)) console.log(`  pattern ${s.pattern.id}: ${s.reason}`);
  process.exit(0);
}

// 4. Insert jitr_offers rows FIRST (so we have offer_id to embed in the card)
const sentResults = [];
for (const o of offered) {
  const { data: row, error: insErr } = await sb
    .from("jitr_offers")
    .insert({
      pattern_id: o.pattern.id,
      rep_id: o.rep.id,
      ai_phrase: o.pattern.ai_phrase,
      sales_phrase: o.pattern.sales_phrase,
      occurrence_count: o.pattern.occurrence_count,
    })
    .select()
    .single();
  if (insErr || !row) {
    console.error(`offer insert fail for pattern ${o.pattern.id} → ${o.rep.name}:`, insErr?.message);
    sentResults.push({ ...o, ok: false, error: insErr?.message });
    continue;
  }
  o.pattern.__offer_id = row.id;
  sentResults.push({ ...o, offer_id: row.id, ok: true });
}

// 5. Send Lark cards
const { token, base } = await getLarkToken();
let sentCount = 0, failCount = 0;
for (const r of sentResults) {
  if (!r.ok) { failCount++; continue; }
  try {
    const { message_id } = await sendJitrCard({ token, base, openId: r.openId, pattern: r.pattern, repName: r.rep.name });
    await sb.from("jitr_offers").update({ card_message_id: message_id }).eq("id", r.offer_id);
    sentCount++;
    console.log(`  ✓ sent to ${r.rep.name}: pattern ${r.pattern.id} (offer ${r.offer_id.slice(0,8)})`);
  } catch (err) {
    console.error(`  ✗ ${r.rep.name}: ${err}`);
    failCount++;
  }
}

// 6. Admin digest
if (adminRep?.lark_open_id) {
  const lines = [];
  lines.push(`📊 JITR daily — ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`offered: ${sentCount}  failed: ${failCount}  skipped: ${skipped.length}`);
  if (offered.length > 0) {
    lines.push(``);
    lines.push(`sent to:`);
    for (const r of sentResults.filter((x) => x.ok)) {
      lines.push(`  • ${r.rep.name} ← "${r.pattern.ai_phrase.slice(0,30)}…" → "${r.pattern.sales_phrase.slice(0,30)}…"`);
    }
  }
  if (unboundReps.size > 0) {
    lines.push(``);
    lines.push(`⚠️  unbound reps (Lark open_id missing) — they're missing JITR offers:`);
    for (const n of unboundReps) lines.push(`  • ${n}`);
    lines.push(`fix: have them DM the bot once, then bind via /api/lark/bind`);
  }
  if (skipped.filter((s) => s.reason.startsWith("multi-rep")).length > 0) {
    lines.push(``);
    lines.push(`👥 multi-rep patterns (admin needs to decide org-wide):`);
    for (const s of skipped.filter((x) => x.reason.startsWith("multi-rep")).slice(0, 5)) {
      lines.push(`  • pattern ${s.pattern.id}: "${s.pattern.ai_phrase.slice(0,40)}…"`);
    }
  }
  await sendDigestText({ token, base, openId: adminRep.lark_open_id, text: lines.join("\n") });
  console.log("admin digest sent");
}

console.log(`\nJITR tick done. sent=${sentCount} failed=${failCount} skipped=${skipped.length}`);
