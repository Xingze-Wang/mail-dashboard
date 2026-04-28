// Tier 6 of docs/DATA_INTEGRITY_PLAN.md.
//
// Runs every "the dashboard would lie if this drifted" invariant the
// audit walked us through. Exits non-zero on any RED. Cron parses the
// exit code; admin sees the same red/yellow/green output as the dev.
//
// What gets checked (each block is one invariant):
//   1. webhook_events freshness        — Tier 0
//   2. emails.resend_id coverage       — every send must be reachable
//   3. inbound.rep_id coverage         — attribution
//   4. wechat marks have actor         — attribution (Tier 3)
//   5. cron sync `complete=true`        — Tier 1.2
//   6. every active rep has sender_email — Tier 3
//
// Run: pnpm integrity
// Cron: same command, exit 0/1/2 → green/yellow/red.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://erguqrisqtugfysofwdd.supabase.co";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

const results = [];

function record(name, status, detail) {
  // status: "green" | "yellow" | "red"
  results.push({ name, status, detail });
  const color = status === "red" ? RED : status === "yellow" ? YELLOW : GREEN;
  const tag = status.toUpperCase().padEnd(6);
  console.log(`${color}[${tag}]${RESET} ${name} — ${detail}`);
}

async function checkWebhookFreshness() {
  // Tier 0. If we sent emails in the last 24h but heard zero events,
  // the webhook is broken (signature mismatch, URL rot, etc.).
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [{ count: events }, { count: sent }] = await Promise.all([
    supabase.from("webhook_events").select("*", { count: "exact", head: true }).gte("created_at", dayAgo),
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("created_at", dayAgo),
  ]);
  if ((sent ?? 0) === 0) {
    record("webhook freshness", "yellow", `no emails sent in last 24h, can't tell if webhook is alive (${events ?? 0} events)`);
    return;
  }
  if ((events ?? 0) === 0) {
    record("webhook freshness", "red", `${sent} emails sent in last 24h but 0 webhook events received — webhook is broken`);
    return;
  }
  record("webhook freshness", "green", `${events} events / ${sent} sent in last 24h`);
}

async function checkResendIdCoverage() {
  const [{ count: total }, { count: missing }] = await Promise.all([
    supabase.from("emails").select("*", { count: "exact", head: true }),
    supabase.from("emails").select("*", { count: "exact", head: true }).is("resend_id", null),
  ]);
  if ((total ?? 0) === 0) {
    record("emails.resend_id coverage", "yellow", "no emails to check");
    return;
  }
  const m = missing ?? 0;
  if (m === 0) {
    record("emails.resend_id coverage", "green", `${total}/${total} have resend_id`);
  } else if (m / total < 0.01) {
    record("emails.resend_id coverage", "yellow", `${m}/${total} missing resend_id (<1%, likely legacy)`);
  } else {
    record("emails.resend_id coverage", "red", `${m}/${total} missing resend_id (>1%)`);
  }
}

async function checkInboundRepCoverage() {
  // Tier 4: rep_id was added in migration 014. Older rows can be NULL,
  // newer rows should not be. So we check coverage on the recent
  // window only — the legacy gap is documented.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ count: total }, { count: missing }] = await Promise.all([
    supabase.from("inbound_emails").select("*", { count: "exact", head: true }).gte("created_at", cutoff),
    supabase
      .from("inbound_emails")
      .select("*", { count: "exact", head: true })
      .gte("created_at", cutoff)
      .is("rep_id", null),
  ]);
  if ((total ?? 0) === 0) {
    record("inbound.rep_id coverage (30d)", "yellow", "no inbound in last 30d");
    return;
  }
  const m = missing ?? 0;
  if (m === 0) {
    record("inbound.rep_id coverage (30d)", "green", `${total}/${total} attributed`);
  } else if (m / total < 0.05) {
    record("inbound.rep_id coverage (30d)", "yellow", `${m}/${total} missing rep_id`);
  } else {
    record("inbound.rep_id coverage (30d)", "red", `${m}/${total} missing rep_id (>5%)`);
  }
}

async function checkWechatActorCoverage() {
  // Tier 3 + project memory: marked_by_rep_id is the actor field. Any
  // mark missing it loses attribution and inflates the wrong rep's
  // numbers in the funnel. Scope to last 30d so legacy gap is excluded.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("brief_lookups")
    .select("id, marked_by_rep_id, wechat_at")
    .gte("wechat_at", cutoff)
    .eq("added_wechat", true);
  if (error) {
    record("wechat marks have actor (30d)", "yellow", `query failed: ${error.message}`);
    return;
  }
  const total = (data ?? []).length;
  const missing = (data ?? []).filter((r) => r.marked_by_rep_id == null).length;
  if (total === 0) {
    record("wechat marks have actor (30d)", "yellow", "no wechat marks in last 30d");
    return;
  }
  if (missing === 0) {
    record("wechat marks have actor (30d)", "green", `${total}/${total} attributed`);
  } else if (missing / total < 0.05) {
    record("wechat marks have actor (30d)", "yellow", `${missing}/${total} missing actor`);
  } else {
    record("wechat marks have actor (30d)", "red", `${missing}/${total} missing actor (>5%)`);
  }
}

async function checkCronSyncRecency() {
  // We don't have a persistent cron-runs log (cron returns JSON in the
  // HTTP response, /api/cron/route.ts). Best proxy: the cron is what
  // pulls latest status from Resend into emails.updated_at, so if no
  // emails.updated_at moved in the last 36h, the cron is stale OR
  // there's been no activity. Fail red only when we know there WAS
  // activity (recent created_at) but updated_at didn't keep pace.
  const day36Ago = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const [{ count: recentlyUpdated }, { count: recentlyCreated }] = await Promise.all([
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("updated_at", day36Ago),
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("created_at", day36Ago),
  ]);
  if ((recentlyUpdated ?? 0) > 0) {
    record("cron sync recency", "green", `${recentlyUpdated} emails updated in last 36h`);
  } else if ((recentlyCreated ?? 0) === 0) {
    record("cron sync recency", "yellow", "no emails created or updated in last 36h (quiet period)");
  } else {
    record(
      "cron sync recency",
      "red",
      `${recentlyCreated} emails created in last 36h but 0 updates — cron sync isn't running`,
    );
  }
}

async function checkRepsHaveSenderEmail() {
  const { data, error } = await supabase.from("sales_reps").select("id, name, sender_email, active");
  if (error) {
    record("active reps have sender_email", "yellow", `query failed: ${error.message}`);
    return;
  }
  const active = (data ?? []).filter((r) => r.active !== false);
  const missing = active.filter((r) => !r.sender_email);
  if (active.length === 0) {
    record("active reps have sender_email", "yellow", "no active reps");
    return;
  }
  if (missing.length === 0) {
    record("active reps have sender_email", "green", `${active.length}/${active.length} have sender_email`);
  } else {
    record(
      "active reps have sender_email",
      "red",
      `${missing.length} missing: ${missing.map((r) => r.name).join(", ")}`,
    );
  }
}

console.log("\n=== Qiji Pipeline integrity report ===");
console.log(`Run at ${new Date().toISOString()}\n`);

await checkWebhookFreshness();
await checkResendIdCoverage();
await checkInboundRepCoverage();
await checkWechatActorCoverage();
await checkCronSyncRecency();
await checkRepsHaveSenderEmail();

const reds = results.filter((r) => r.status === "red").length;
const yellows = results.filter((r) => r.status === "yellow").length;
const greens = results.filter((r) => r.status === "green").length;

console.log(`\nSummary: ${greens} green / ${yellows} yellow / ${reds} red`);

if (reds > 0) {
  process.exit(2);
} else if (yellows > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
