# Leon admin daily report + admin-action framing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Wire (a) admin-specific daily report at 09:00 Beijing replacing the per-rep standup for admin role, and (b) admin-action framing in lark-agent so Leon executes action tools confidently instead of just describing them.

**Architecture:** Migration 084 relaxes `lark_messages.role` CHECK to add `'action'` and `'system'`. New `src/lib/admin-daily-report.ts` builds the report text from `Promise.all` of section-builders (org volume, per-rep rates, AI usage, alerts). `/api/cron/standup` branches on `rep.role === 'admin'` to send the report instead of the per-rep standup. `src/lib/lark-agent.ts` gets `MAX_ITERATIONS = session.role === 'admin' ? 8 : 3` and an admin-prompt addendum. Action tool dispatch wraps with `lark_messages` insert (role='action') for audit. Two new read tools (`get_recent_admin_actions`, `get_admin_daily_report`) registered.

**Spec:** `docs/superpowers/specs/2026-05-13-leon-admin-daily-report-design.md`

**Open questions answered with defaults:** 09:00 Beijing, DM not group, verbatim threshold ≤5, audit-by-rep_id.

---

## File map

**New:**
- `migrations/084-lark-messages-action-role.sql` + `scripts/apply-084.mjs`
- `src/lib/admin-daily-report.ts` — builds the message text
- `scripts/test-admin-daily-report.mjs` — integration smoke

**Modified:**
- `src/app/api/cron/standup/route.ts` — branch on admin role
- `src/lib/lark-agent.ts` — admin MAX_ITERATIONS, admin prompt addendum, action audit
- `src/lib/helper-tools.ts` — register new read tools, add to TOOLS_PROMPT
- `src/lib/helper-read-tools.ts` — dispatch new read tools

---

## Task 1: Migration 084

**Files:**
- Create: `migrations/084-lark-messages-action-role.sql`
- Create: `scripts/apply-084.mjs`

- [ ] **Step 1: Migration file**

```sql
-- migrations/084-lark-messages-action-role.sql
--
-- 1. SCHEMA CHANGE
-- Relax lark_messages.role CHECK constraint to accept 'action' and 'system'
-- in addition to existing 'user' | 'assistant'. Used by lark-agent.ts to
-- log every action-tool fire as an audit row, and by /api/cron/standup
-- to mark its outbound messages with role='system' (so they don't pollute
-- conversation history when Leon re-reads context for follow-up DMs).
--
-- 2. WHO WRITES THIS?
-- 'action': src/lib/lark-agent.ts after each successful action-tool dispatch
-- 'system': src/app/api/cron/standup/route.ts after sending the standup DM
--
-- 3. WHO READS THIS?
-- 'action' rows: Leon's get_recent_admin_actions tool reads them
-- 'system' rows: Excluded from conversation-history loading in lark-agent
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — only future rows use the new values

ALTER TABLE lark_messages DROP CONSTRAINT IF EXISTS lark_messages_role_check;
ALTER TABLE lark_messages ADD CONSTRAINT lark_messages_role_check
  CHECK (role IN ('user', 'assistant', 'action', 'system'));
```

- [ ] **Step 2: Apply runner**

`scripts/apply-084.mjs` matching `apply-083.mjs` shape:

```javascript
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/084-lark-messages-action-role.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

// Probe: insert a test 'action' row, verify it accepts, delete it
const probeInsert = await sb.from("lark_messages").insert({
  chat_id: "oc_probe_084",
  role: "action",
  text: "[probe-084] migration constraint check",
}).select("id").maybeSingle();
if (probeInsert.error) {
  console.error("Probe insert action failed:", probeInsert.error.message);
  process.exit(1);
}
await sb.from("lark_messages").delete().eq("id", probeInsert.data.id);
console.log("OK: lark_messages.role now accepts 'action' (verified by round-trip insert)");
```

- [ ] **Step 3: Run + commit**

```bash
node scripts/apply-084.mjs
# expect: OK: lark_messages.role now accepts 'action' (verified by round-trip insert)
git add migrations/084-lark-messages-action-role.sql scripts/apply-084.mjs
git commit -m "migration(084): relax lark_messages.role CHECK to allow 'action' + 'system'"
```

---

## Task 2: admin-daily-report library

**Files:**
- Create: `src/lib/admin-daily-report.ts`
- Create: `scripts/test-admin-daily-report.mjs`

The library has one public export: `buildAdminDailyReport(): Promise<string>` returning the formatted Chinese message. Internally, five `Promise.all` section-fetchers. Each section is wrapped in try/catch — failure renders "—" instead of throwing.

- [ ] **Step 1: Write the smoke test first**

`scripts/test-admin-daily-report.mjs`:

```javascript
/**
 * Smoke: buildAdminDailyReport produces a string with key sections.
 * Doesn't assert specific numbers (those vary by date) — just that
 * the message has the expected structure.
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
```

- [ ] **Step 2: Run, verify fails (module not found)**

`npx tsx --env-file=.env.local scripts/test-admin-daily-report.mjs` → expect import error.

- [ ] **Step 3: Implement `src/lib/admin-daily-report.ts`**

```typescript
/**
 * Builds the admin's daily org-wide report sent at 09:00 Beijing.
 *
 * One public export: buildAdminDailyReport(). Five sections fetched
 * in parallel; failure in any section renders "—" so a single broken
 * source doesn't blank the report.
 *
 * Output is plain text (Chinese) targeting Lark DM. Uses light markdown
 * (** **) which Lark renders as bold.
 */

import { supabase } from "@/lib/db";

const VERBATIM_THRESHOLD = 5; // edit_distance ≤ 5 ≈ verbatim accept

function isoStartOfYesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function isoEndOfYesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}
function isoStartOfWeek(): string {
  // Monday 00:00 UTC. Treat Sunday as last day of prior week.
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon..6=Sat
  const daysFromMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function pct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

interface OrgMetrics {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  wechat: number;
}

async function fetchOrgMetrics(sinceIso: string, untilIso?: string): Promise<OrgMetrics> {
  // Sent
  let sent = 0;
  {
    const q = supabase.from("emails").select("id", { count: "exact", head: true }).gte("created_at", sinceIso);
    if (untilIso) q.lte("created_at", untilIso);
    const r = await q;
    sent = r.count ?? 0;
  }
  // Email IDs for opened/clicked/replied lookups
  let emailIds: string[] = [];
  {
    const q = supabase.from("emails").select("id").gte("created_at", sinceIso);
    if (untilIso) q.lte("created_at", untilIso);
    const r = await q.limit(5000);
    emailIds = (r.data ?? []).map((e) => e.id as string);
  }
  let opened = 0, clicked = 0, replied = 0;
  if (emailIds.length > 0) {
    const o = await supabase
      .from("webhook_events")
      .select("email_id")
      .eq("type", "email.opened")
      .in("email_id", emailIds);
    opened = new Set((o.data ?? []).map((e) => e.email_id as string)).size;

    const c = await supabase
      .from("webhook_events")
      .select("email_id")
      .eq("type", "email.clicked")
      .in("email_id", emailIds);
    clicked = new Set((c.data ?? []).map((e) => e.email_id as string)).size;

    const rep = await supabase
      .from("inbound_emails")
      .select("source_email_id")
      .in("source_email_id", emailIds);
    replied = new Set((rep.data ?? []).map((e) => e.source_email_id as string)).size;
  }
  // WeChat marks
  let wechat = 0;
  {
    const q = supabase.from("brief_lookups").select("id", { count: "exact", head: true }).eq("added_wechat", true).gte("wechat_at", sinceIso);
    if (untilIso) q.lte("wechat_at", untilIso);
    const r = await q;
    wechat = r.count ?? 0;
  }
  return { sent, opened, clicked, replied, wechat };
}

interface PerRepRow {
  rep_id: number;
  name: string;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  wechat: number;
}

async function fetchPerRepMetrics(sinceIso: string, untilIso: string): Promise<PerRepRow[]> {
  const reps = await supabase
    .from("sales_reps")
    .select("id, name, role")
    .eq("active", true)
    .neq("role", "admin")  // admins don't send; skip from per-rep table
    .order("id");
  if (!reps.data) return [];
  const out: PerRepRow[] = [];
  for (const rep of reps.data) {
    const emails = await supabase
      .from("emails")
      .select("id")
      .eq("actor_rep_id", rep.id)
      .gte("created_at", sinceIso)
      .lte("created_at", untilIso)
      .limit(2000);
    const ids = (emails.data ?? []).map((e) => e.id as string);
    if (ids.length === 0) {
      out.push({ rep_id: rep.id as number, name: rep.name as string, sent: 0, opened: 0, clicked: 0, replied: 0, wechat: 0 });
      continue;
    }
    const [o, c, r, w] = await Promise.all([
      supabase.from("webhook_events").select("email_id").eq("type", "email.opened").in("email_id", ids),
      supabase.from("webhook_events").select("email_id").eq("type", "email.clicked").in("email_id", ids),
      supabase.from("inbound_emails").select("source_email_id").in("source_email_id", ids),
      supabase.from("brief_lookups").select("id", { count: "exact", head: true })
        .eq("added_wechat", true).eq("marked_by_rep_id", rep.id)
        .gte("wechat_at", sinceIso).lte("wechat_at", untilIso),
    ]);
    out.push({
      rep_id: rep.id as number,
      name: rep.name as string,
      sent: ids.length,
      opened: new Set((o.data ?? []).map((e) => e.email_id as string)).size,
      clicked: new Set((c.data ?? []).map((e) => e.email_id as string)).size,
      replied: new Set((r.data ?? []).map((e) => e.source_email_id as string)).size,
      wechat: w.count ?? 0,
    });
  }
  return out;
}

interface AiUsageRow {
  rep_id: number;
  name: string;
  sent: number;
  verbatim_pct: number;       // % of sends with edit_distance ≤ VERBATIM_THRESHOLD
  median_edit_distance: number;
  top_edit_reason: string | null;
}

async function fetchAiUsage(sinceIso: string): Promise<AiUsageRow[]> {
  const reps = await supabase
    .from("sales_reps")
    .select("id, name, role")
    .eq("active", true)
    .neq("role", "admin")
    .order("id");
  if (!reps.data) return [];
  const out: AiUsageRow[] = [];
  for (const rep of reps.data) {
    const r = await supabase
      .from("pipeline_leads")
      .select("draft_edit_distance, edit_reasons")
      .eq("status", "sent")
      .eq("assigned_rep_id", rep.id)
      .gte("sent_at", sinceIso)
      .limit(500);
    const rows = r.data ?? [];
    if (rows.length === 0) {
      out.push({ rep_id: rep.id as number, name: rep.name as string, sent: 0, verbatim_pct: 0, median_edit_distance: 0, top_edit_reason: null });
      continue;
    }
    const distances = rows.map((x) => (x.draft_edit_distance as number | null) ?? 0).sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)];
    const verbatim = distances.filter((d) => d <= VERBATIM_THRESHOLD).length;
    // Top edit reason (across all rows' edit_reasons arrays)
    const reasonCounts = new Map<string, number>();
    for (const row of rows) {
      const reasons = (row.edit_reasons as string[] | null) ?? [];
      for (const reason of reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    let topReason: string | null = null;
    let topCount = 0;
    for (const [reason, count] of reasonCounts) {
      if (count > topCount) { topCount = count; topReason = reason; }
    }
    out.push({
      rep_id: rep.id as number,
      name: rep.name as string,
      sent: rows.length,
      verbatim_pct: Math.round((verbatim / rows.length) * 100),
      median_edit_distance: median,
      top_edit_reason: topReason,
    });
  }
  return out;
}

interface AlertRow { kind: string; text: string; }

async function fetchAlerts(): Promise<AlertRow[]> {
  const alerts: AlertRow[] = [];
  const today = new Date().toISOString().slice(0, 10);
  // Quota vs pool warnings
  try {
    const quotas = await supabase.from("rep_daily_quotas").select("rep_id, per_pool");
    const reps = await supabase.from("sales_reps").select("id, name").eq("active", true);
    const nameById = new Map((reps.data ?? []).map((r) => [r.id, r.name as string]));
    const pools: Record<string, number> = {};
    for (const pk of ["strong", "normal_cn", "normal_overseas", "normal_edu"]) {
      const r = await supabase.from("v_lead_pool").select("id", { count: "exact", head: true }).eq("pool_key", pk);
      pools[pk] = r.count ?? 0;
    }
    for (const q of quotas.data ?? []) {
      const pp = (q.per_pool as Record<string, number>) ?? {};
      for (const [pk, want] of Object.entries(pp)) {
        if (want > 0 && pools[pk] < want) {
          alerts.push({
            kind: "underfill",
            text: `${nameById.get(q.rep_id as number) ?? `rep#${q.rep_id}`} 今天 ${pk} quota=${want} 但 pool 只有 ${pools[pk]}`,
          });
        }
      }
    }
  } catch (e) { console.error("[admin-daily-report] alerts/quota failed:", e); }
  // Stale wechat marks
  try {
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const r = await supabase
      .from("brief_lookups")
      .select("id, marked_by_rep_id")
      .eq("added_wechat", true)
      .lte("wechat_at", cutoff)
      .is("wechat_followup_at", null)
      .limit(50);
    if ((r.data ?? []).length > 0) {
      // Group by rep
      const byRep = new Map<number, number>();
      for (const row of r.data ?? []) {
        const k = row.marked_by_rep_id as number;
        byRep.set(k, (byRep.get(k) ?? 0) + 1);
      }
      const reps = await supabase.from("sales_reps").select("id, name").in("id", Array.from(byRep.keys()));
      const nameById = new Map((reps.data ?? []).map((r) => [r.id, r.name as string]));
      const parts = Array.from(byRep.entries()).map(([repId, n]) => `${nameById.get(repId) ?? `rep#${repId}`} ${n}`);
      alerts.push({ kind: "stale_wechat", text: `${r.data!.length} 个 wechat mark 超过 14 天没跟进 (${parts.join(", ")})` });
    }
  } catch (e) { console.error("[admin-daily-report] alerts/wechat failed:", e); }
  // Integrity report — reuse the integrity-checks lib if available
  try {
    const { runIntegrity } = await import("@/lib/integrity-checks");
    const report = await runIntegrity();
    const red = (report as { red?: unknown[] }).red?.length ?? 0;
    if (red > 0) alerts.push({ kind: "integrity_red", text: `集成检查 ${red} 个 red — 用 get_integrity_report 看详情` });
    else alerts.push({ kind: "integrity_ok", text: `✅ 集成检查全部通过` });
  } catch {
    // integrity check is optional — silent miss
  }
  // Suppress today's date var unused warning
  void today;
  return alerts;
}

function renderMessage(input: {
  orgYesterday: OrgMetrics;
  orgWeek: OrgMetrics;
  perRepYesterday: PerRepRow[];
  aiUsageWeek: AiUsageRow[];
  alerts: AlertRow[];
}): string {
  const lines: string[] = [];
  lines.push(`📊 早安 — 今日 admin report`);
  lines.push(``);
  const y = input.orgYesterday;
  lines.push(`**昨天 (org-wide)**`);
  lines.push(`  发送: ${y.sent} 封 · 打开: ${y.opened} (${pct(y.opened, y.sent)}) · 点击: ${y.clicked} (${pct(y.clicked, y.sent)}) · 回复: ${y.replied} (${pct(y.replied, y.sent)})`);
  lines.push(`  微信新加: ${y.wechat}`);
  lines.push(``);
  const w = input.orgWeek;
  lines.push(`**本周累计 (周一 → 今天)**`);
  lines.push(`  发送: ${w.sent} 封 · 打开: ${w.opened} (${pct(w.opened, w.sent)}) · 点击: ${w.clicked} (${pct(w.clicked, w.sent)}) · 回复: ${w.replied} (${pct(w.replied, w.sent)})`);
  lines.push(`  微信新加: ${w.wechat}`);
  lines.push(``);
  if (input.perRepYesterday.length > 0) {
    lines.push(`**按 rep 看 (昨天)**`);
    for (const r of input.perRepYesterday) {
      if (r.sent === 0) {
        lines.push(`  ${r.name.padEnd(8)} 0 发`);
        continue;
      }
      const wxMark = r.wechat > 0 ? ` · ${r.wechat} wx ✓` : "";
      lines.push(`  ${r.name.padEnd(8)} ${r.sent} 发, ${r.opened} 开 (${pct(r.opened, r.sent)}), ${r.clicked} 点 (${pct(r.clicked, r.sent)}), ${r.replied} 回${wxMark}`);
    }
    lines.push(``);
  }
  if (input.aiUsageWeek.some((r) => r.sent > 0)) {
    lines.push(`**reps 怎么用 AI (本周)**`);
    for (const r of input.aiUsageWeek) {
      if (r.sent === 0) continue;
      const reasonPart = r.top_edit_reason ? ` · 主要原因 "${r.top_edit_reason}"` : "";
      lines.push(`  ${r.name.padEnd(8)} 逐字接受 ${r.verbatim_pct}% · 中位编辑距离 ${r.median_edit_distance} 字${reasonPart}`);
    }
    lines.push(``);
  }
  lines.push(`**需要你注意**`);
  if (input.alerts.length === 0) {
    lines.push(`  ✅ 没看到需要立刻处理的`);
  } else {
    for (const a of input.alerts) {
      const prefix = a.kind === "integrity_ok" ? "" : "⚠️ ";
      lines.push(`  ${prefix}${a.text}`);
    }
  }
  lines.push(``);
  lines.push(`**有什么要我做** — DM 我就行, 例如:`);
  lines.push(`  • "把 Jinyang 今天的 overseas lead 转给 Ethan"`);
  lines.push(`  • "今天的 strong lead 全部 redraft 一遍"`);
  lines.push(`  • "你今天做了什么"  → 我会列出今天帮你做过的操作`);
  return lines.join("\n");
}

export async function buildAdminDailyReport(): Promise<string> {
  const yStart = isoStartOfYesterday();
  const yEnd = isoEndOfYesterday();
  const wStart = isoStartOfWeek();
  const nowIso = new Date().toISOString();
  // Each section caught — failure renders empty/placeholder, doesn't blank the whole report
  const [orgYesterday, orgWeek, perRepYesterday, aiUsageWeek, alerts] = await Promise.all([
    fetchOrgMetrics(yStart, yEnd).catch((e) => { console.error("[admin-daily-report] org/yesterday:", e); return { sent: 0, opened: 0, clicked: 0, replied: 0, wechat: 0 }; }),
    fetchOrgMetrics(wStart, nowIso).catch((e) => { console.error("[admin-daily-report] org/week:", e); return { sent: 0, opened: 0, clicked: 0, replied: 0, wechat: 0 }; }),
    fetchPerRepMetrics(yStart, yEnd).catch((e) => { console.error("[admin-daily-report] per-rep:", e); return []; }),
    fetchAiUsage(wStart).catch((e) => { console.error("[admin-daily-report] ai-usage:", e); return []; }),
    fetchAlerts().catch((e) => { console.error("[admin-daily-report] alerts:", e); return []; }),
  ]);
  return renderMessage({ orgYesterday, orgWeek, perRepYesterday, aiUsageWeek, alerts });
}
```

- [ ] **Step 4: Run test, verify passes**

`npx tsx --env-file=.env.local scripts/test-admin-daily-report.mjs`

Expect 6 assertions passing AND the rendered report printed to stdout so we can eyeball the actual numbers.

- [ ] **Step 5: tsc + commit**

```bash
npx tsc --noEmit
git add src/lib/admin-daily-report.ts scripts/test-admin-daily-report.mjs
git commit -m "feat(leon): admin-daily-report library

Builds a Chinese org-wide daily report for admin's 09:00 Beijing DM:
- yesterday + this-week org volume (sent, opened, clicked, replied, wx)
- per-rep yesterday table
- per-rep AI usage (verbatim accept %, median edit distance, top reason)
- alerts (quota underfills, stale wechat, integrity reds)

Each section wrapped in try/catch — single failure doesn't blank the report.
No new schema; reuses emails, webhook_events, inbound_emails, brief_lookups,
pipeline_leads, rep_daily_quotas, v_lead_pool, integrity-checks."
```

---

## Task 3: standup route branches on admin role

**Files:**
- Modify: `src/app/api/cron/standup/route.ts`

- [ ] **Step 1: Read current standup route**

`src/app/api/cron/standup/route.ts` is ~120 lines. Find the loop iterating `reps` and sending per-rep DMs. Inside the loop, add a branch:

```typescript
for (const rep of reps.data ?? []) {
  // ─── Admin path: org-wide daily report instead of per-rep standup ──
  if (rep.role === "admin") {
    if (!rep.lark_open_id) {
      details.push({ rep_id: rep.id, name: rep.name, sent: false, reason: "no lark_open_id" });
      continue;
    }
    try {
      const { buildAdminDailyReport } = await import("@/lib/admin-daily-report");
      const text = await buildAdminDailyReport();
      const r = await sendMessage({
        receive_id: rep.lark_open_id,
        receive_id_type: "open_id",
        text,
      });
      const ok = r && (r as { ok?: boolean }).ok === true;
      if (ok) {
        // Audit row: role='system' so it doesn't pollute conversation context
        await supabase.from("lark_messages").insert({
          chat_id: `dm:${rep.lark_open_id}`,
          rep_id: rep.id,
          role: "system",
          text: text.slice(0, 4000),
        }).then(() => null).catch(() => null);
      }
      details.push({ rep_id: rep.id, name: rep.name, sent: ok, kind: "admin-daily-report" });
      if (ok) sent++; else skipped++;
    } catch (e) {
      console.error(`[standup] admin daily report failed for rep ${rep.id}:`, e);
      details.push({ rep_id: rep.id, name: rep.name, sent: false, reason: "report build failed" });
      skipped++;
    }
    continue;
  }
  // ─── Existing sales-rep path (unchanged) ──────────────────────────
  // ... existing code stays here ...
}
```

The exact integration depends on existing variable names (`details`, `sent`, `skipped`). Adapt to match.

**SELECT update:** The reps query needs to fetch `role` and `lark_open_id`. Confirm both are already in the SELECT — if not, add them.

- [ ] **Step 2: tsc + commit**

```bash
npx tsc --noEmit
git add src/app/api/cron/standup/route.ts
git commit -m "feat(leon): standup cron sends admin-daily-report to role='admin' reps

Before this commit, admins received the same per-rep DM as sales reps
(empty queue, no signal). Now admins get an org-wide report covering
yesterday's volume, per-rep rates, AI usage, and alerts. Sales rep path
is unchanged."
```

---

## Task 4: lark-agent admin-action framing

**Files:**
- Modify: `src/lib/lark-agent.ts`

- [ ] **Step 1: Bump MAX_ITERATIONS for admin**

Find `const MAX_ITERATIONS = 3;` (around line 195). Replace with a function-scope const based on role. The variable is referenced inside `runAgent(session, ...)`, so move the assignment inside the function:

```typescript
async function runAgent(session: LarkSession, question: string, history: { role: "user" | "assistant"; text: string }[]): Promise<string> {
  const MAX_ITERATIONS = session.role === "admin" ? 8 : 3;
  // ... rest unchanged ...
}
```

Delete the module-level `MAX_ITERATIONS = 3` const.

- [ ] **Step 2: Add admin-prompt addendum**

After the existing `system = SYSTEM_BASE + "\n" + TOOLS_PROMPT;` line, add:

```typescript
if (session.role === "admin") {
  system += `

## 你正在跟 admin 对话

Admin 找你不只是问数字, 他会让你做事:
  • "把 X 的 lead 转给 Y" → 用 reassign_lead 或 reassign_leads_bulk
  • "把今天 strong 全部 redraft" → 用 redraft_lead / bulk_flag
  • "给 X 发一封" → 用 batch_send
  • "你今天做了什么" → 用 get_recent_admin_actions
  • "今天的 report 长什么样" → 用 get_admin_daily_report

规则:
  1. 真的去做, 不要只描述 ("我可以帮你 reassign..." → 直接 reassign)
  2. 单条操作直接做; >5 条批量操作先 DM 一下 "我要做 X, 共 N 条, 确认?" 再做
  3. 做完之后报告: 操作了什么, 影响了几条
  4. 失败也直接说, 不要假装成功
`;
}
```

- [ ] **Step 3: Audit trail for action-tool calls**

Find where the agent loop dispatches tool calls — it's in `runAgent` calling `runReadTool(session, c)` in a `Promise.all`. The current loop only handles READ tools. For admin role, also dispatch ACTION tools.

This is delicate. The existing tool loop is:
```typescript
const calls = extractReadToolCalls(text);
if (calls.length === 0) {
  finalText = text;
  break;
}
const results = await Promise.all(calls.map((c) => runReadTool(session, c)));
```

We need a parallel for ACTION tools: extract them, dispatch, audit. Add (immediately after the existing read-tool dispatch):

```typescript
// Admin-only: also dispatch ACTION tool calls in the same round.
if (session.role === "admin") {
  const { extractActionToolCalls } = await import("@/lib/helper-tools");
  const { runActionTool } = await import("@/lib/helper-action-tools");
  const actionCalls = extractActionToolCalls(text);
  if (actionCalls.length > 0) {
    const actionResults = await Promise.all(actionCalls.map((c) => runActionTool(session, c)));
    // Audit each
    for (let i = 0; i < actionCalls.length; i++) {
      const c = actionCalls[i];
      const r = actionResults[i];
      try {
        await supabase.from("lark_messages").insert({
          chat_id: session.chatId ?? `dm:rep_${session.repId}`,
          rep_id: session.repId,
          role: "action",
          text: `[action:${c.tool}] ${JSON.stringify(c.args).slice(0, 300)} → ${JSON.stringify(r.result).slice(0, 500)}`,
          raw: { tool: c.tool, args: c.args, result: r.result, ts: new Date().toISOString() },
        });
      } catch (e) {
        console.error(`[lark-agent] audit log failed for ${c.tool}:`, e);
      }
    }
    // Fold action results into the next-round prompt so Leon can report what he did
    const actionSummary = actionResults.map((r, i) => `### ${actionCalls[i].tool}(${JSON.stringify(actionCalls[i].args)}) →\n${JSON.stringify(r.result).slice(0, 2000)}`).join("\n\n");
    userPrompt = `${userPrompt}\n\n## 操作结果 (round ${iter + 1})\n${actionSummary}\n\n基于操作结果回答 admin: 你做了什么, 影响了几条.`;
  }
}
```

**Prerequisite checks:**
- `src/lib/helper-tools.ts` must export `extractActionToolCalls` similar to existing `extractReadToolCalls`. Verify; add if missing.
- `src/lib/helper-action-tools.ts` must export `runActionTool(session, call)` returning `{tool, result}`. Verify; the existing module likely has it given `ACTION_TOOL_NAMES` is defined.
- `LarkSession` type must include `chatId`. Verify; if missing, use `dm:rep_${session.repId}` as fallback (already shown above).

- [ ] **Step 4: tsc + commit**

```bash
npx tsc --noEmit
git add src/lib/lark-agent.ts
git commit -m "feat(leon): admin-action framing + audit trail

Admin role:
- MAX_ITERATIONS bumped 3 → 8 (multi-step work in one DM)
- System prompt addendum: 'use action tools, don't just describe'
- Every action-tool call audited to lark_messages with role='action'
- Action results fed back to Leon's next round so he can report what he did

Sales-rep path unchanged (MAX_ITERATIONS=3, no admin addendum)."
```

---

## Task 5: New read tools `get_recent_admin_actions` + `get_admin_daily_report`

**Files:**
- Modify: `src/lib/helper-tools.ts` (register tool names + TOOLS_PROMPT entry)
- Modify: `src/lib/helper-read-tools.ts` (dispatch handlers)

- [ ] **Step 1: Register in `READ_TOOL_NAMES`**

In `src/lib/helper-tools.ts`, add to `READ_TOOL_NAMES`:

```typescript
"get_recent_admin_actions",
"get_admin_daily_report",
```

Add to `TOOLS_PROMPT`:

```
- get_recent_admin_actions — admin 今天通过你做过的操作列表. args: {}. 返回: { ok, actions: [{tool, args, result, when}] }. admin-only.
- get_admin_daily_report — 重新生成今天的 admin daily report 文本 (org volume + 按 rep 表 + AI 使用 + 警告). args: {}. 返回: { ok, text }. admin-only.
```

- [ ] **Step 2: Dispatch handlers in `helper-read-tools.ts`**

Inside the `switch (call.tool)` in `runReadTool`, add:

```typescript
case "get_recent_admin_actions": {
  if (session.role !== "admin") {
    return { tool: call.tool, result: { ok: false, error: "admin only" } };
  }
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const { supabase } = await import("@/lib/db");
  const r = await supabase
    .from("lark_messages")
    .select("text, raw, created_at")
    .eq("role", "action")
    .eq("rep_id", session.repId)
    .gte("created_at", startOfToday.toISOString())
    .order("created_at", { ascending: true })
    .limit(50);
  if (r.error) return { tool: call.tool, result: { ok: false, error: r.error.message } };
  return {
    tool: call.tool,
    result: {
      ok: true,
      actions: (r.data ?? []).map((m) => {
        const raw = m.raw as { tool?: string; args?: unknown; result?: unknown } | null;
        return {
          tool: raw?.tool ?? "?",
          args: raw?.args ?? null,
          result: raw?.result ?? null,
          when: m.created_at,
        };
      }),
    },
  };
}
case "get_admin_daily_report": {
  if (session.role !== "admin") {
    return { tool: call.tool, result: { ok: false, error: "admin only" } };
  }
  try {
    const { buildAdminDailyReport } = await import("@/lib/admin-daily-report");
    const text = await buildAdminDailyReport();
    return { tool: call.tool, result: { ok: true, text } };
  } catch (e) {
    return { tool: call.tool, result: { ok: false, error: e instanceof Error ? e.message : String(e) } };
  }
}
```

- [ ] **Step 3: tsc + commit**

```bash
npx tsc --noEmit
git add src/lib/helper-tools.ts src/lib/helper-read-tools.ts
git commit -m "feat(leon): admin-only read tools get_recent_admin_actions + get_admin_daily_report

Leon can now answer 'what did you do today' (lists role='action' rows
from lark_messages this UTC day) and 'show me today's report'
(rebuilds buildAdminDailyReport on demand)."
```

---

## Task 6: Smoke test + deploy

- [ ] **Step 1: Run smoke test locally**

```bash
npx tsx --env-file=.env.local scripts/test-admin-daily-report.mjs
```

Verify the rendered report has all 5 sections and reasonable numbers.

- [ ] **Step 2: Push + deploy via vercel-deploy skill**

- [ ] **Step 3: Smoke test the cron in prod**

Manually trigger the standup cron with bearer auth via curl. Hit calistamind.com with bypass token. Confirm:
1. The cron response shows `details: [..., {kind: "admin-daily-report", sent: true, ...}, ...]` for admin reps
2. You receive the DM in Lark with all the sections
3. `lark_messages` has a `role='system'` row for the report

- [ ] **Step 4: Smoke test admin action via DM**

In Lark, DM Leon: `"把 leo 的 strong quota 改成 5"`. Expect:
- Leon calls action tool (e.g. via direct DB update through quota-store, if a tool exists) OR replies "I can't do that — need a quota-edit tool" if no such tool exists yet
- If action fires, `lark_messages.role='action'` row appears
- Leon's reply confirms what he did

Then: `"你今天做了什么"`. Expect Leon to call `get_recent_admin_actions` and list the quota change.

No commit — operational verification.

---

## Out of scope (deferred)

- Approval cards for batch actions (`batch_send > 5`)
- Sales-rep AI-usage feedback (telling each rep their own verbatim acceptance)
- Skill registry (Rung 2)
- A web `/admin/daily-report` page (Lark first)
- Cross-day audit-trail view (admin asking "what did you do this week")
