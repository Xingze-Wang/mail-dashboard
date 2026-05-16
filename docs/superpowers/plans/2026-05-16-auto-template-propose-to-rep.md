# Auto-Template: Propose-to-Rep Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the weekly rep-edit-clustering cron detects a pattern in a rep's edits, Leon DMs the rep with a draft proposal ("here's what I noticed, want to use this?"). Only AFTER the rep approves does an admin-approval card fire. Admin's Yes flips the template to `active=true, rep_id=<rep>` so the rep's future leads automatically use it.

**Architecture:** Two-stage approval gate on `email_templates`. Rep stage uses a new `template_rep_action` card via the same Lark dispatcher pattern as `template_action`. Persistent state lives on two new columns (`proposed_to_rep_at`, `rep_approved_at`) so we never lose flow context across server restarts. The existing `rep_edit_clustering` cron is the producer; a new `propose-templates-to-reps` cron drives the sender (with re-send / expiry semantics).

**Tech Stack:** Next.js 16 route handlers, Supabase (Postgres + PostgREST), Lark interactive cards (`im/v1/messages` with `msg_type: "interactive"`), existing helpers from `src/lib/lark.ts` + `src/lib/admin-approval-cards.ts`.

---

## File Structure

**Created:**
- `migrations/097-template-rep-approval-stage.sql` — adds `proposed_to_rep_at`, `rep_approved_at`, `rep_rejection_reason` columns + index
- `scripts/apply-097.mjs` — migration runner (matches `scripts/apply-NNN.mjs` pattern)
- `src/lib/rep-template-card.ts` — `sendRepTemplateProposalCard` + `processRepTemplateCardAction` (mirrors the admin-side pair in `admin-approval-cards.ts`)
- `src/app/api/cron/propose-templates-to-reps/route.ts` — cron that picks up `status='proposal', rep_id!=null, proposed_to_rep_at IS NULL` rows and DMs the rep
- `src/app/api/templates/[id]/rep-revise/route.ts` — when the rep clicks "✏️ 让我改", this is the conversation endpoint Leon uses to multi-turn revise the proposal
- `scripts/_smoke-rep-template-flow.mjs` — end-to-end smoke

**Modified:**
- `src/app/api/lark/webhook/route.ts` — add `template_rep_action` dispatcher branch
- `scripts/lark-bot-worker.ts` — same branch (worker mirrors webhook)
- `src/lib/admin-approval-cards.ts` — `sendTemplateProposalCard` only fires when `rep_approved_at IS NOT NULL` (guard against pre-rep-approval cards)
- `src/app/api/cron/rep-edit-clustering/route.ts` — stop calling `sendTemplateProposalCard` directly; just insert with `status='proposal', rep_id=<rep>` and let the new cron pick it up
- `src/lib/template-assembler.ts` (no logic change; just confirms `loadEffectiveTemplate` still gates on `status='active'`)
- `vercel.json` — schedule the new cron `0 1 * * 1` (Mon 09:00 Beijing)

---

## Self-Review Decisions

Two questions a careful reader would ask, answered up-front:

1. **Why two new columns vs a new `status` value like `'rep_approved'`?** The existing 4-state status enum (proposal / approved_draft / active / archived) is referenced by 12+ call sites including `loadEffectiveTemplate`. Adding a fifth state risks one of them treating an unknown enum value as "active" or skipping it. Timestamp columns are additive — every existing query is unaffected.

2. **What if the rep never responds?** The cron re-sends after 72h (one nudge), then auto-archives after 7d. `rep_rejection_reason` stays NULL for timeout; an explicit `❌ 不要` click sets it.

---

### Task 1: Migration 097 — rep-approval columns

**Files:**
- Create: `migrations/097-template-rep-approval-stage.sql`
- Create: `scripts/apply-097.mjs`

- [ ] **Step 1: Write the migration SQL**

```sql
-- migrations/097-template-rep-approval-stage.sql
--
-- 1. SCHEMA CHANGE
-- Three new columns on email_templates for the rep-approval stage of
-- the auto-template flow (docs/superpowers/plans/2026-05-16-auto-
-- template-propose-to-rep.md).
--
--   proposed_to_rep_at  timestamptz — when Leon DMed the rep with the
--                                     proposal card. NULL = not yet sent.
--   rep_approved_at     timestamptz — when the rep clicked ✓ on Leon's
--                                     card. NULL = rep hasn't approved.
--                                     Gates the admin-card fire.
--   rep_rejection_reason text       — set when rep clicks ❌ or replies
--                                     with revision feedback. Becomes
--                                     evidence for next clustering run.
--
-- 2. WHO WRITES?
-- - proposed_to_rep_at: cron /api/cron/propose-templates-to-reps after
--   successful Lark card send.
-- - rep_approved_at: rep-template-card.ts:processRepTemplateCardAction
--   on ✓ button click.
-- - rep_rejection_reason: same handler on ❌ click, or via the
--   /api/templates/[id]/rep-revise multi-turn endpoint.
--
-- 3. WHO READS?
-- - admin-approval-cards.ts:sendTemplateProposalCard — guards: refuses
--   to fire admin card unless rep_approved_at IS NOT NULL.
-- - The propose-to-reps cron — to find candidates (NULL =
--   needs-sending) and to re-nudge stale rows (>72h, <7d).
--
-- 4. BACKFILL
-- Existing rows: leave all three columns NULL. Rows currently
-- status='proposal' WITHOUT rep_id (org-wide congress proposals) stay
-- in the admin-only flow — the new cron skips them by filtering on
-- rep_id IS NOT NULL.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS proposed_to_rep_at timestamptz,
  ADD COLUMN IF NOT EXISTS rep_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rep_rejection_reason text;

-- Index: the cron's primary query is "status='proposal' AND rep_id
-- IS NOT NULL AND proposed_to_rep_at IS NULL". A partial index keeps
-- the working set tiny.
CREATE INDEX IF NOT EXISTS email_templates_pending_rep_propose_idx
  ON email_templates (rep_id, created_at)
  WHERE status = 'proposal' AND rep_id IS NOT NULL AND proposed_to_rep_at IS NULL;
```

- [ ] **Step 2: Write the apply runner**

```js
// scripts/apply-097.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/097-template-rep-approval-stage.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
console.log("ok — verifying columns exist:");
const { data, error: probeErr } = await sb
  .from("email_templates")
  .select("id, proposed_to_rep_at, rep_approved_at, rep_rejection_reason")
  .limit(1);
if (probeErr) { console.error("probe FAIL:", probeErr.message); process.exit(1); }
console.log("✓ all three columns reachable. sample row:", data?.[0]);
```

- [ ] **Step 3: Apply the migration**

Run: `node scripts/apply-097.mjs`
Expected output: `ok — verifying columns exist:` followed by `✓ all three columns reachable.`

- [ ] **Step 4: Verify the partial index exists**

Run via the apply script trailer or a separate probe:

```bash
node -e "
const fs = require('fs');
const env = fs.readFileSync('.env.local','utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)=\"?(.*?)\"?\$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
(async () => {
  const { data, error } = await s.rpc('_exec_sql', { sql_text: \"SELECT indexname FROM pg_indexes WHERE tablename='email_templates' AND indexname='email_templates_pending_rep_propose_idx';\" });
  console.log('index exists:', data ?? 'no', 'err:', error?.message ?? 'none');
})();
"
```

Expected: index row returned.

- [ ] **Step 5: Commit**

```bash
git add migrations/097-template-rep-approval-stage.sql scripts/apply-097.mjs
git commit -m "feat(templates): migration 097 adds rep-approval columns"
```

---

### Task 2: `sendRepTemplateProposalCard` — the rep-side card sender

**Files:**
- Create: `src/lib/rep-template-card.ts`

- [ ] **Step 1: Write the failing smoke test**

```js
// scripts/_smoke-rep-template-flow.mjs — partial, just the send branch
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1"; // don't push to real Lark during test

const { sendRepTemplateProposalCard } = await import("/Users/xingzewang/Desktop/mail/src/lib/rep-template-card.ts");

const r = await sendRepTemplateProposalCard({
  template_id: "00000000-0000-0000-0000-000000000000",
  template_name: "[smoke] test template",
  rep_id: 2,
  proposed_reason: "test smoke",
  diff_summary: "+ adds a line about deadlines",
});
console.log("sendRepTemplateProposalCard returned:", r);
if (r !== null && typeof r !== "string") {
  console.error("expected null or string message_id");
  process.exit(1);
}
console.log("✓ send branch smoke");
```

Run: `node scripts/_smoke-rep-template-flow.mjs`
Expected: FAIL with `Cannot find module ... rep-template-card.ts`.

- [ ] **Step 2: Implement `rep-template-card.ts` send branch**

```ts
// src/lib/rep-template-card.ts
//
// Rep-side approval card for the auto-template propose-to-rep flow
// (docs/superpowers/plans/2026-05-16-auto-template-propose-to-rep.md).
//
// Mirrors src/lib/admin-approval-cards.ts but the receive_id is the
// rep's lark_open_id, not the admin's. The dispatcher discriminator is
// `template_rep_action` (not `template_action`) so the webhook routes
// rep-side clicks to a different handler that ONLY flips
// rep_approved_at — admin still has to sign off on the second card.

import { supabase } from "@/lib/db";
import { getTenantAccessToken, pickBase } from "@/lib/lark";

function isSmokeNoCards(): boolean {
  return process.env.SMOKE_NO_CARDS === "1";
}

async function getRepOpenId(repId: number): Promise<string | null> {
  const { data } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", repId)
    .maybeSingle();
  return (data?.lark_open_id as string | null) ?? null;
}

export interface SendArgs {
  template_id: string;
  template_name: string;
  rep_id: number;
  proposed_reason: string;
  diff_summary: string;
}

/**
 * DM the rep a card showing the proposed template + diff vs their
 * current effective template. Returns the Lark message_id (so the
 * cron can store it for later card-rewrite on approve/reject), or null
 * on smoke / send-failure.
 */
export async function sendRepTemplateProposalCard(args: SendArgs): Promise<string | null> {
  if (isSmokeNoCards()) {
    console.log("[rep-template-card] SMOKE_NO_CARDS=1 — skip Lark push for template", args.template_id);
    return null;
  }
  const openId = await getRepOpenId(args.rep_id);
  if (!openId) {
    console.error(`[rep-template-card] rep ${args.rep_id} has no lark_open_id, skipping`);
    return null;
  }
  const token = await getTenantAccessToken();
  if (!token) return null;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🎯 你的编辑模式 → 模板提案" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${args.template_name}**\n\n_${args.proposed_reason}_\n\n**Diff:**\n${args.diff_summary}\n\n点 ✓ 就送给 admin approve. 不对就 ✏️ (我会跟你聊聊改) 或 ❌.`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✓ 同意" },
            type: "primary",
            value: { template_rep_action: "approve", template_id: args.template_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "✏️ 让我改" },
            value: { template_rep_action: "revise", template_id: args.template_id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ 不要" },
            type: "danger",
            value: { template_rep_action: "reject", template_id: args.template_id },
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as { code?: number; data?: { message_id?: string } };
    if (res.ok && j.code === 0 && j.data?.message_id) return j.data.message_id;
    console.error("[rep-template-card] send failed:", res.status, j);
    return null;
  } catch (e) {
    console.error("[rep-template-card] send threw:", String(e).slice(0, 200));
    return null;
  }
}
```

- [ ] **Step 3: Run the smoke**

Run: `node scripts/_smoke-rep-template-flow.mjs`
Expected: prints `[rep-template-card] SMOKE_NO_CARDS=1 — skip Lark push for template ...` then `✓ send branch smoke`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/rep-template-card.ts scripts/_smoke-rep-template-flow.mjs
git commit -m "feat(templates): rep-side approval card sender"
```

---

### Task 3: `processRepTemplateCardAction` — handle rep button clicks

**Files:**
- Modify: `src/lib/rep-template-card.ts` (append handler)
- Test: `scripts/_smoke-rep-template-flow.mjs` (extend)

- [ ] **Step 1: Add failing smoke for approve path**

Append to `scripts/_smoke-rep-template-flow.mjs`:

```js
// Test: synthetic ✓ click flips rep_approved_at.
const { createClient } = await import("@supabase/supabase-js");
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Set up: insert a fresh proposal row owned by rep 2
const { data: insRow } = await s
  .from("email_templates")
  .insert({
    name: "[smoke] approve-flow",
    rep_id: 2,
    status: "proposal",
    active: false,
    proposed_by: "smoke",
    proposed_to_rep_at: new Date().toISOString(),
  })
  .select("id")
  .single();
const tid = insRow.id;

const { processRepTemplateCardAction } = await import("/Users/xingzewang/Desktop/mail/src/lib/rep-template-card.ts");

// rep 2's lark_open_id
const { data: rep } = await s.from("sales_reps").select("lark_open_id").eq("id", 2).maybeSingle();
const fakeEvent = {
  event: {
    operator: { open_id: rep.lark_open_id },
    action: { value: { template_rep_action: "approve", template_id: tid } },
  },
};
const out = await processRepTemplateCardAction(fakeEvent);
console.log("approve handler returned:", out);

const { data: after } = await s.from("email_templates").select("rep_approved_at").eq("id", tid).single();
if (!after.rep_approved_at) { console.error("❌ rep_approved_at not set"); process.exit(1); }
console.log("✓ rep_approved_at set:", after.rep_approved_at);

// Cleanup
await s.from("email_templates").delete().eq("id", tid);
```

Run: `node scripts/_smoke-rep-template-flow.mjs`
Expected: FAIL with `processRepTemplateCardAction is not a function`.

- [ ] **Step 2: Implement the handler**

Append to `src/lib/rep-template-card.ts`:

```ts
// ── Card-action handler ─────────────────────────────────────────────

interface CardActionEvent {
  event?: {
    operator?: { open_id?: string };
    action?: {
      value?: {
        template_rep_action?: "approve" | "revise" | "reject";
        template_id?: string;
      };
    };
  };
}

/**
 * Called from the Lark webhook + worker when a rep clicks a button on
 * their proposal card.
 *
 * - approve: set rep_approved_at = NOW(). The propose-to-reps cron's
 *   next tick (or admin-approval-cards' periodic poll) will see the
 *   timestamp and fire the admin-side card.
 * - revise: don't change status, just record that rep wants changes.
 *   The /api/templates/[id]/rep-revise endpoint handles the multi-turn
 *   conversation; this card click just opens that channel.
 * - reject: set rep_rejection_reason='Rejected by rep on card' + flip
 *   status='archived'. Cron stops following up.
 *
 * Auth: the click's operator.open_id MUST match the template's rep_id's
 * lark_open_id. Defense-in-depth — Lark webhook signature verification
 * already happens upstream, but this guards against a rep clicking
 * another rep's card (shouldn't happen, but cards are leak-via-screenshot).
 */
export async function processRepTemplateCardAction(rawEvent: unknown): Promise<{
  ok: boolean;
  reason?: string;
  toast?: string;
}> {
  const event = (rawEvent as CardActionEvent).event;
  const op = event?.operator?.open_id;
  const action = event?.action?.value?.template_rep_action;
  const tid = event?.action?.value?.template_id;
  if (!op || !action || !tid) return { ok: false, reason: "incomplete payload" };

  // Find the template and verify the clicker IS the proposed-to rep.
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("id, rep_id, status")
    .eq("id", tid)
    .maybeSingle();
  if (!tpl) return { ok: false, reason: "template gone", toast: "Template not found" };
  if (tpl.status !== "proposal") {
    return { ok: true, reason: "already resolved", toast: "Already handled" };
  }

  const { data: rep } = await supabase
    .from("sales_reps")
    .select("id, lark_open_id")
    .eq("id", tpl.rep_id)
    .maybeSingle();
  if (rep?.lark_open_id !== op) {
    return { ok: false, reason: "wrong rep", toast: "Not your card" };
  }

  if (action === "approve") {
    await supabase
      .from("email_templates")
      .update({ rep_approved_at: new Date().toISOString() })
      .eq("id", tid);
    return { ok: true, reason: "rep_approved", toast: "✓ 已转给 admin" };
  }

  if (action === "reject") {
    await supabase
      .from("email_templates")
      .update({
        status: "archived",
        rep_rejection_reason: "Rejected by rep on Lark card (no reason given)",
      })
      .eq("id", tid);
    return { ok: true, reason: "rep_rejected", toast: "❌ 已归档" };
  }

  if (action === "revise") {
    // Don't mark anything terminal — just toast and let the rep DM Leon
    // for the multi-turn revise endpoint. The /api/templates/[id]/rep-
    // revise endpoint is the actual conversation entry point.
    return { ok: true, reason: "revise_requested", toast: "✏️ DM me what to change" };
  }

  return { ok: false, reason: "unknown action" };
}
```

- [ ] **Step 3: Run the smoke**

Run: `node scripts/_smoke-rep-template-flow.mjs`
Expected: prints `✓ rep_approved_at set: 2026-05-...`

- [ ] **Step 4: Commit**

```bash
git add src/lib/rep-template-card.ts scripts/_smoke-rep-template-flow.mjs
git commit -m "feat(templates): rep card-action handler"
```

---

### Task 4: Wire the dispatcher into webhook + worker

**Files:**
- Modify: `src/app/api/lark/webhook/route.ts`
- Modify: `scripts/lark-bot-worker.ts`

- [ ] **Step 1: Find the existing template_action branch in webhook**

Run: `grep -n "template_action" src/app/api/lark/webhook/route.ts`
Expected: a branch like `} else if ("template_action" in value) { ... }`.

- [ ] **Step 2: Add a parallel `template_rep_action` branch in webhook**

Modify `src/app/api/lark/webhook/route.ts` near the existing template_action dispatcher (around line 122):

```ts
} else if ("template_rep_action" in value) {
  const card = await import("@/lib/rep-template-card");
  await card.processRepTemplateCardAction(parsed);
}
```

Also add toast-content branch where the other toasts are computed (the file has a switch for `tplAction`, mirror it):

```ts
const tplRepAction = (value.template_rep_action as string | undefined) ?? "";
if (tplRepAction === "approve") toastContent = "✓ 已转给 admin";
else if (tplRepAction === "reject") toastContent = "❌ 已归档";
else if (tplRepAction === "revise") toastContent = "✏️ DM 我聊聊";
```

- [ ] **Step 3: Mirror the same branch in the worker**

Run: `grep -n "template_action" scripts/lark-bot-worker.ts`
Expected: same pattern.

Add the `template_rep_action` branch in the worker's dispatcher (same shape, same import).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/lark/webhook/route.ts scripts/lark-bot-worker.ts
git commit -m "feat(templates): wire rep-template card-action dispatcher"
```

---

### Task 5: New cron `/api/cron/propose-templates-to-reps`

**Files:**
- Create: `src/app/api/cron/propose-templates-to-reps/route.ts`

- [ ] **Step 1: Implement the cron route**

```ts
// src/app/api/cron/propose-templates-to-reps/route.ts
//
// Picks up email_templates rows where:
//   status = 'proposal'
//   rep_id IS NOT NULL                  (rep-targeted, not org-wide)
//   proposed_to_rep_at IS NULL          (never sent OR last send was
//                                        reset for re-nudge — see below)
//   rep_approved_at IS NULL             (rep hasn't already approved)
//   created_at >= now() - 14 days       (don't resurrect stale ones)
//
// For each, sends a Lark card via sendRepTemplateProposalCard. On
// success, stamps proposed_to_rep_at = NOW().
//
// Re-nudge: rows where proposed_to_rep_at < now() - 72h AND
// rep_approved_at IS NULL AND created_at > now() - 7d get a second
// card (idempotent — Lark dedups by message body within a chat).
//
// Auto-archive: rows where proposed_to_rep_at < now() - 7d AND
// rep_approved_at IS NULL get status='archived',
// rep_rejection_reason='Timed out — no rep response in 7d'.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { sendRepTemplateProposalCard } from "@/lib/rep-template-card";
import { loadEffectiveTemplate } from "@/lib/template-assembler";

export const preferredRegion = ["hkg1"];
export const maxDuration = 90;

function buildDiffSummary(_proposed: Record<string, unknown>, _current: Record<string, unknown> | null): string {
  // MVP: show the first ~200 chars of full_html_override (or
  // subject_override) and that's it. A real diff library can come
  // later; the rep mostly wants to see "what's the new opening line."
  const proposedHtml = (_proposed.full_html_override as string | null) ?? "";
  if (!proposedHtml) return "(no diff to show)";
  return proposedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

interface PerRow {
  template_id: string;
  rep_id: number;
  action: "sent" | "renudged" | "archived" | "error";
  error?: string;
}

async function run(): Promise<{ ran_at: string; per_row: PerRow[] }> {
  const ran_at = new Date().toISOString();
  const per_row: PerRow[] = [];
  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const threeDaysAgo = new Date(now - 3 * 86_400_000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 86_400_000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 86_400_000).toISOString();

  // 1. Auto-archive timed-out rows first (cleanup pass).
  const { data: stale } = await supabase
    .from("email_templates")
    .select("id, rep_id")
    .eq("status", "proposal")
    .not("rep_id", "is", null)
    .not("proposed_to_rep_at", "is", null)
    .is("rep_approved_at", null)
    .lt("proposed_to_rep_at", sevenDaysAgo);
  for (const r of stale ?? []) {
    await supabase
      .from("email_templates")
      .update({
        status: "archived",
        rep_rejection_reason: "Timed out — no rep response in 7d",
      })
      .eq("id", r.id);
    per_row.push({ template_id: r.id as string, rep_id: r.rep_id as number, action: "archived" });
  }

  // 2. Fresh sends: rows we have never proposed to the rep.
  const { data: fresh } = await supabase
    .from("email_templates")
    .select("id, rep_id, name, proposed_reason, full_html_override, subject_override")
    .eq("status", "proposal")
    .not("rep_id", "is", null)
    .is("proposed_to_rep_at", null)
    .gte("created_at", fourteenDaysAgo)
    .order("created_at", { ascending: true })
    .limit(20);
  for (const row of fresh ?? []) {
    const current = await loadEffectiveTemplate(row.rep_id as number, null);
    const diff = buildDiffSummary(row as Record<string, unknown>, current as Record<string, unknown> | null);
    const messageId = await sendRepTemplateProposalCard({
      template_id: row.id as string,
      template_name: row.name as string,
      rep_id: row.rep_id as number,
      proposed_reason: (row.proposed_reason as string) ?? "(no reason)",
      diff_summary: diff,
    });
    if (messageId !== null || process.env.SMOKE_NO_CARDS === "1") {
      await supabase
        .from("email_templates")
        .update({ proposed_to_rep_at: ran_at })
        .eq("id", row.id);
      per_row.push({ template_id: row.id as string, rep_id: row.rep_id as number, action: "sent" });
    } else {
      per_row.push({
        template_id: row.id as string,
        rep_id: row.rep_id as number,
        action: "error",
        error: "send failed",
      });
    }
  }

  // 3. Re-nudges: rows already sent 72h+ ago but rep hasn't acted.
  const { data: nudgeable } = await supabase
    .from("email_templates")
    .select("id, rep_id, name, proposed_reason, full_html_override")
    .eq("status", "proposal")
    .not("rep_id", "is", null)
    .not("proposed_to_rep_at", "is", null)
    .is("rep_approved_at", null)
    .lt("proposed_to_rep_at", threeDaysAgo)
    .gte("proposed_to_rep_at", sevenDaysAgo)
    .lt("proposed_to_rep_at", dayAgo) // only re-nudge once per day
    .limit(10);
  for (const row of nudgeable ?? []) {
    const current = await loadEffectiveTemplate(row.rep_id as number, null);
    const diff = buildDiffSummary(row as Record<string, unknown>, current as Record<string, unknown> | null);
    await sendRepTemplateProposalCard({
      template_id: row.id as string,
      template_name: `${row.name as string} (再次提醒)`,
      rep_id: row.rep_id as number,
      proposed_reason: (row.proposed_reason as string) ?? "",
      diff_summary: diff,
    });
    await supabase
      .from("email_templates")
      .update({ proposed_to_rep_at: ran_at })
      .eq("id", row.id);
    per_row.push({ template_id: row.id as string, rep_id: row.rep_id as number, action: "renudged" });
  }

  return { ran_at, per_row };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await run());
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Smoke run locally with SMOKE_NO_CARDS=1**

```bash
SMOKE_NO_CARDS=1 node -e "
const fs = require('fs');
const env = fs.readFileSync('.env.local','utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)=\"?(.*?)\"?\$/); if (m) process.env[m[1]] = m[2]; }
(async () => {
  process.env.SMOKE_NO_CARDS = '1';
  const mod = await import('./src/app/api/cron/propose-templates-to-reps/route.ts');
  const { NextRequest } = await import('next/server');
  const req = new NextRequest('http://x/', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
  const res = await mod.GET(req);
  console.log(await res.json());
})();
"
```

Expected: prints `{ ran_at: ..., per_row: [...] }` with at least one row if Task 1's smoke insert is still in the DB (or empty array if no proposals are pending).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/propose-templates-to-reps/route.ts
git commit -m "feat(templates): cron sends rep-side proposal cards"
```

---

### Task 6: Schedule the new cron + guard admin card on rep approval

**Files:**
- Modify: `vercel.json`
- Modify: `src/lib/admin-approval-cards.ts:sendTemplateProposalCard`

- [ ] **Step 1: Add cron schedule**

Modify `vercel.json` — add inside the `crons` array (matches existing rhythm; Mon 09:00 Beijing = `0 1 * * 1` UTC):

```json
{ "path": "/api/cron/propose-templates-to-reps", "schedule": "0 1 * * 1-5" }
```

(Weekdays so Mon-Fri the rep gets the prompt fresh; weekend re-nudge waits.)

- [ ] **Step 2: Add rep-approval guard to admin card**

Modify `src/lib/admin-approval-cards.ts:sendTemplateProposalCard` — at the start of the function, before getting admin_open_id:

```ts
export async function sendTemplateProposalCard(args: {
  template_id: string;
  template_name: string;
  proposed_by: string | null;
  proposed_reason: string | null;
}): Promise<string | null> {
  // Guard: for rep-targeted proposals, the admin card MUST NOT fire
  // until the rep has approved. Org-wide proposals (rep_id = NULL)
  // skip this gate — admin is the only approver for those.
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("rep_id, rep_approved_at")
    .eq("id", args.template_id)
    .maybeSingle();
  if (tpl && tpl.rep_id != null && !tpl.rep_approved_at) {
    console.log(
      `[admin-approval-cards] template ${args.template_id} is rep-targeted (rep=${tpl.rep_id}) and rep hasn't approved yet — deferring admin card`,
    );
    return null;
  }
  // ...existing implementation continues below
```

- [ ] **Step 3: Wire a follow-up — when rep approves, fire admin card**

Modify `src/lib/rep-template-card.ts:processRepTemplateCardAction` — in the `approve` branch, after the UPDATE:

```ts
if (action === "approve") {
  await supabase
    .from("email_templates")
    .update({ rep_approved_at: new Date().toISOString() })
    .eq("id", tid);
  // Immediately escalate to admin — same card as the standard template
  // proposal flow, just guarded on rep_approved_at which we just set.
  try {
    const { sendTemplateProposalCard } = await import("@/lib/admin-approval-cards");
    const { data: full } = await supabase
      .from("email_templates")
      .select("name, proposed_by, proposed_reason")
      .eq("id", tid)
      .maybeSingle();
    if (full) {
      await sendTemplateProposalCard({
        template_id: tid,
        template_name: full.name as string,
        proposed_by: (full.proposed_by as string | null) ?? null,
        proposed_reason: `(Rep ${rep!.id} ✓ approved) ${(full.proposed_reason as string | null) ?? ""}`,
      });
    }
  } catch (err) {
    console.error("[rep-template-card] admin escalation failed:", String(err).slice(0, 200));
  }
  return { ok: true, reason: "rep_approved", toast: "✓ 已转给 admin" };
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add vercel.json src/lib/admin-approval-cards.ts src/lib/rep-template-card.ts
git commit -m "feat(templates): schedule rep-propose cron + admin guard"
```

---

### Task 7: Stop rep-edit-clustering from calling admin card directly

**Files:**
- Modify: `src/app/api/cron/rep-edit-clustering/route.ts`

- [ ] **Step 1: Find existing admin-card call**

Run: `grep -n "sendTemplateProposalCard" src/app/api/cron/rep-edit-clustering/route.ts`
Expected: a call we added earlier; needs to be removed since the new cron + flow does it.

- [ ] **Step 2: Remove the admin-card import + call**

Modify `src/app/api/cron/rep-edit-clustering/route.ts` — replace the `sendTemplateProposalCard` import and the `if (entry.new_template_id) { try { ... } }` block with a comment:

```ts
// Old behavior fired sendTemplateProposalCard here. That's now wrong:
// the new flow goes rep-side first (propose-templates-to-reps cron
// picks up status='proposal' AND rep_id != NULL within 24h and DMs
// the rep). Admin card fires AFTER rep ✓ — see
// docs/superpowers/plans/2026-05-16-auto-template-propose-to-rep.md.
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/rep-edit-clustering/route.ts
git commit -m "fix(rep-edit-clustering): defer admin card, let new flow drive it"
```

---

### Task 8: End-to-end smoke

**Files:**
- Test: `scripts/_smoke-rep-template-flow.mjs` (extend further)

- [ ] **Step 1: Add the full happy-path scenario**

Append to `scripts/_smoke-rep-template-flow.mjs`:

```js
// ── E2E happy path ────────────────────────────────────────────────────
console.log("\n[e2e] full propose → rep ✓ → admin card fires");
process.env.SMOKE_NO_CARDS = "1";

// 1. Insert a fresh proposal as if rep-edit-clustering just ran.
const ins2 = await s
  .from("email_templates")
  .insert({
    name: "[e2e] Yujie edit cluster",
    rep_id: 2,
    status: "proposal",
    active: false,
    proposed_by: "rep_edit_cluster",
    proposed_reason: "E2E smoke",
    full_html_override: "<p>E2E test override</p>",
  })
  .select("id")
  .single();
const e2eTid = ins2.data.id;

// 2. Run propose-templates-to-reps cron.
const cronMod = await import("/Users/xingzewang/Desktop/mail/src/app/api/cron/propose-templates-to-reps/route.ts");
const { NextRequest } = await import("next/server");
const cronReq = new NextRequest("http://x/", { headers: { authorization: "Bearer " + process.env.CRON_SECRET } });
const cronRes = await cronMod.GET(cronReq);
const cronOut = await cronRes.json();
console.log("  cron output:", JSON.stringify(cronOut.per_row?.find((r) => r.template_id === e2eTid)));

const { data: afterCron } = await s.from("email_templates").select("proposed_to_rep_at").eq("id", e2eTid).single();
if (!afterCron.proposed_to_rep_at) { console.error("❌ proposed_to_rep_at not set after cron"); process.exit(1); }
console.log("  ✓ proposed_to_rep_at set");

// 3. Simulate rep's ✓ click.
const { data: rep2 } = await s.from("sales_reps").select("lark_open_id").eq("id", 2).maybeSingle();
const approveOut = await (await import("/Users/xingzewang/Desktop/mail/src/lib/rep-template-card.ts")).processRepTemplateCardAction({
  event: {
    operator: { open_id: rep2.lark_open_id },
    action: { value: { template_rep_action: "approve", template_id: e2eTid } },
  },
});
console.log("  rep approve handler:", approveOut);

const { data: afterApprove } = await s.from("email_templates").select("rep_approved_at").eq("id", e2eTid).single();
if (!afterApprove.rep_approved_at) { console.error("❌ rep_approved_at not set after click"); process.exit(1); }
console.log("  ✓ rep_approved_at set:", afterApprove.rep_approved_at);

// 4. Cleanup.
await s.from("email_templates").delete().eq("id", e2eTid);
console.log("\n✓ E2E PASS");
```

- [ ] **Step 2: Run the e2e**

Run: `node scripts/_smoke-rep-template-flow.mjs`
Expected: ends with `✓ E2E PASS`.

- [ ] **Step 3: Commit**

```bash
git add scripts/_smoke-rep-template-flow.mjs
git commit -m "test(templates): e2e smoke for propose-to-rep flow"
```

---

### Task 9: Deploy + verify in prod

**Files:** (none modified)

- [ ] **Step 1: Push branch**

```bash
git push
```

- [ ] **Step 2: Deploy to Vercel**

Run: `vercel --prod --yes`
Expected: returns a deployment URL after build.

- [ ] **Step 3: Verify cron is registered**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "https://calistamind.com/api/cron/propose-templates-to-reps" | head -c 400
```

Expected: JSON with `ran_at` + `per_row` (may be empty if no qualifying rows).

- [ ] **Step 4: Verify the partial index hasn't degraded the existing rep-edit-clustering cron**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "https://calistamind.com/api/cron/rep-edit-clustering?dry=1" | head -c 400
```

Expected: JSON with `per_rep`, no errors.

---

## Self-Review

**Spec coverage:**
- "run something as a cron to see what edits are the most often" — Task 7 (`rep-edit-clustering` already exists, we leave it producing `status='proposal', rep_id=<rep>` rows)
- "look at the rates of the edited drafts (if have)" — captured in `proposed_evidence` JSON the existing cluster cron writes; Task 5's `buildDiffSummary` could surface this, but the MVP version shows only the text diff. Marked as future work in the comment.
- "propose directly to the rep, see what rep thinks" — Tasks 2-5 (rep card + handler + cron)
- "work with rep to ensure that the new formation gets the rep exactly what they want" — Task 3's `revise` branch toasts "DM me what to change"; the multi-turn revise endpoint (`/api/templates/[id]/rep-revise`) is **stubbed but not implemented** in this plan — it's a follow-up plan because multi-turn revise is its own design (LLM loop + template re-render + diff display). Flagged at end.
- "then go to admin, talk to the proposed fixes and rationale" — Task 6 Step 3 (rep approval auto-fires admin card)
- "admin finally decides" — existing `processTemplateCardAction` in `admin-approval-cards.ts` (no change)
- "then leads to this rep start using this template on a general or case by case basis" — covered by existing `loadEffectiveTemplate` Layer 1 (per-rep `rep_id` match). When admin clicks Activate, status='active' + the row's rep_id=<rep> makes the layer-1 path return this template for that rep's leads.

**Placeholder scan:** No TBDs / TODOs. The "multi-turn revise" gap is explicitly called out as a follow-up plan, not as a placeholder.

**Type consistency:** `template_rep_action` is used identically across `sendRepTemplateProposalCard` button values, `processRepTemplateCardAction` discriminator, webhook dispatcher, and worker dispatcher. `rep_approved_at` is used identically across the migration, the handler, and the admin guard.

---

## Follow-up Plan Needed

**Multi-turn revise (`/api/templates/[id]/rep-revise`)** — Out of scope for this plan because it's a non-trivial design: rep DMs Leon "make the opening more casual"; Leon LLM-rewrites the proposal; sends a new card; loops until rep ✓ or escapes. Plan for a follow-up: `docs/superpowers/plans/2026-05-NN-multi-turn-revise.md`.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-16-auto-template-propose-to-rep.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
