# Shared lead pool, mission-driven daily allocation, and mission UX fix

**Date:** 2026-05-13
**Author:** Xingze (with Claude)
**Status:** Draft — awaiting approval

## Problem

Today's lead routing is **deterministic at import time**:

- Python scanner (`resend0412.py`) POSTs to `/api/pipeline/import`
- `assignRep()` decides the rep from `lead_tier + geo + matched_directions` and writes `assigned_rep_id` immediately
- Result: Yujie owns every `.cn` lead, Ethan owns every overseas lead, Leo owns every strong lead. Volumes are whatever the day's arXiv mix produced — no rebalancing, no capacity awareness.

Two real consequences:

1. **Load imbalance.** A heavy `.cn` day buries Yujie; a heavy overseas day buries Ethan. Today's mechanism has no concept of "fair share."
2. **Capacity blindness.** New reps ramping up (Chenyu, started 2026-04-23), reps on PTO, reps with weak draft queues all get the same firehose. The mission system already encodes per-rep daily capacity in `missions.target` — but nothing reads it.

Separately, the **mission system itself is invisible to reps**:

- No sidebar link to `/missions` (only the floating `MissionsDot` pill, which renders only when `incomplete > 0 && total > 0` — invisible to new reps with no missions yet)
- `/pipeline` (the daily landing surface) has zero references to missions
- Lark onboarding walkthrough (`src/lib/onboarding.ts`) explicitly names `/pipeline`, `/emails`, `/inbox` but never mentions missions
- `/admin/missions` exists but has no sidebar link either — admins reach it only via Congress notification text or direct URL

These two problems are coupled: if allocation becomes mission-driven, "rep doesn't see their mission" = "rep doesn't know what to work on." We have to fix both together.

## Goals

1. **Defer lead ownership** from import time to a daily allocation cron, so volume per rep is decided by mission targets, not by what arXiv happened to publish.
2. **Partition the pool by segment** (strong / normal-cn / normal-overseas / normal-edu) so today's specialization (Leo on strong, Yujie on .cn, Ethan on overseas) is preserved as the *default*, but admin can flex it per-rep per-day via mission scope.
3. **Make the mission system the visible daily routine for reps** — sidebar link, `/pipeline` banner, onboarding walkthrough, empty-state for the dot, and a mission ↔ pipeline filter bridge.
4. **Give admin a visible allocation surface** — see today's pool inventory, see each rep's mission target, override allocations.

## Non-goals

- **No new allocation tables.** `assigned_rep_id IS NULL` already means "unassigned." We do not need a `lead_pool`, `claims`, or `claimed_at` columns.
- **No loose-claim / expiring-claim semantics.** Stickiness: once a lead is allocated to a rep, it stays until sent / skipped / admin-reassigned. Same semantics as today's `assigned_rep_id`, just set later.
- **No rep-driven cherry-picking UI.** Allocation is system-driven from mission targets. (Cherry-picking was explicitly rated lower priority.)
- **No change to draft content or template logic.** Drafts still render at send time via `assembleDraft()`. The only difference is *when* `assigned_rep_id` is set, so *when* the draft-queue worker picks the lead up.
- **No change to attribution semantics.** `actor_rep_id` (send), `marked_by_rep_id` (WeChat conversion) remain unchanged.

## High-level architecture

```
                                    ┌──────────────────────────┐
Python scanner POST                 │ /api/pipeline/import     │
   (resend0412.py)        ─────────▶│  - classifyLead()        │
                                    │  - geo classify          │
                                    │  - assigned_rep_id NULL  │  ◀── change
                                    │  - draft_html: optional  │
                                    └────────────┬─────────────┘
                                                 │
                                                 ▼
                                    ┌──────────────────────────┐
                                    │ pipeline_leads (pool)    │
                                    │  - lead_tier             │
                                    │  - geo (derived)         │
                                    │  - assigned_rep_id NULL  │
                                    └────────────┬─────────────┘
                                                 │
            ┌────────────────────────────────────┼─────────────────────────────────┐
            │                                    │                                 │
            ▼                                    ▼                                 ▼
  ┌──────────────────────┐         ┌────────────────────────┐         ┌──────────────────────┐
  │ /api/missions/       │         │ /api/missions/         │         │ /api/admin/          │
  │   heuristic-seed     │         │   allocate-leads       │  ◀── new │   allocation         │
  │ (existing, daily)    │         │ (NEW cron, daily)      │         │ (NEW admin surface)  │
  │ ─ creates missions   │         │ ─ reads mission.target │         │ ─ inventory by pool  │
  │   with target + scope│  ────▶  │   + scope.per_pool     │  ────▶  │ ─ per-rep allocation │
  │                      │         │ ─ fills sub-pools FIFO │         │   override           │
  └──────────────────────┘         │ ─ sets assigned_rep_id │         └──────────────────────┘
                                   └───────────┬────────────┘
                                               │
                                               ▼
                                  ┌──────────────────────────┐
                                  │ draft-queue worker       │
                                  │ (existing)               │
                                  │ renders draft_html for   │
                                  │ newly-assigned leads     │
                                  └──────────────────────────┘
```

## Detailed design

### 1. Sub-pool taxonomy

Each lead carries the tags it already has (`lead_tier`, `school_tier`, `geo`-derived, `matched_directions`, `citation_count`, `h_index`, `local_score`, `industry_orgs`). The **pool partition** is a derived label, computed at allocation time:

| Sub-pool key | Predicate |
|---|---|
| `strong` | `lead_tier = 'strong'` (regardless of geo) |
| `normal_cn` | `lead_tier = 'normal' AND geo = 'cn'` |
| `normal_overseas` | `lead_tier = 'normal' AND geo = 'other'` |
| `normal_edu` | `lead_tier = 'normal' AND geo = 'edu'` |

This is **derived, not stored.** `geo` itself is derived from email domain via `isOverseas()`. We expose it via a SQL view `v_lead_pool` for the allocation cron and admin surface:

```sql
CREATE VIEW v_lead_pool AS
SELECT
  id, person_id, author_email, lead_tier, school_tier,
  citation_count, h_index, matched_directions,
  CASE
    WHEN author_email LIKE '%.cn' OR author_email LIKE '%.cn.%' THEN 'cn'
    WHEN author_email LIKE '%.edu' OR author_email LIKE '%.edu.%' THEN 'edu'
    ELSE 'other'
  END AS geo,
  CASE
    WHEN lead_tier = 'strong' THEN 'strong'
    WHEN lead_tier = 'normal' AND author_email LIKE '%.cn%' THEN 'normal_cn'
    WHEN lead_tier = 'normal' AND author_email LIKE '%.edu%' THEN 'normal_edu'
    ELSE 'normal_overseas'
  END AS pool_key,
  created_at
FROM pipeline_leads
WHERE assigned_rep_id IS NULL
  AND status IN ('new', 'queued');         -- not sent, not skipped
```

(Earlier drafts of this spec included `AND skipped_at IS NULL` as belt-and-suspenders, but `pipeline_leads` has no `skipped_at` column in production — `status='skipped'` is the only skip marker, and is already excluded by the `status IN ('new', 'queued')` filter. See migration 082 for the verified shape.)

`matched_directions` does **not** define its own sub-pool (otherwise we get 20 buckets). It becomes a **priority hint** within the strong pool — allocator picks direction-matched leads first when filling Leo's strong target.

### 2. Mission `scope` shape

Today `missions.scope` is an unspecified JSONB column. We give it a concrete shape for `kind='send'` missions:

```json
{
  "per_pool": {
    "strong": 3,
    "normal_cn": 0,
    "normal_overseas": 0,
    "normal_edu": 0
  },
  "direction_priority": ["embodied_robotics", "world_models"]
}
```

- `per_pool` — sub-pool → count. Sum should equal `missions.target` (validated at write time, soft-warned if mismatched).
- `direction_priority` — optional, only consulted within the `strong` pool, ordered by preference.

**Source of truth: admin-set daily quotas (NOT heuristic).**

We retire the auto-inferred `target = clamp(ready_count, 5, 12)` for `send` missions. The number of leads per rep per day is **admin policy, not a guess**. The flow:

1. Admin opens `/admin/missions` (see §8.1 for the new nav link)
2. There's a **"Daily quotas"** panel (new — see §8.3) showing each rep's `per_pool` allocation as editable inputs. Values persist as the rep's *standing daily quota* in a new table `rep_daily_quotas` (see §10 schema). Admin sets once; values carry forward to every weekday until changed.
3. The `heuristic-seed` cron reads `rep_daily_quotas` and creates that day's `missions` rows with `target = sum(per_pool)` and `scope.per_pool = stored quotas`. **Missions are auto-approved (`status='active'`) when sourced from admin quotas** — admin already set the policy in `/admin/missions`, no second approval needed.
4. If a rep has no quota row, the seeder **skips them** (no phantom missions) and emits a Lark DM to admin: `"Chenyu has no daily quota set. Set one at /admin/missions."`

| Rep | Example quota an admin might set |
|---|---|
| Leo (strong specialist) | `{strong: 8, normal_cn: 0, normal_overseas: 0, normal_edu: 0}` |
| Yujie | `{strong: 0, normal_cn: 12, normal_overseas: 0, normal_edu: 0}` |
| Ethan | `{strong: 0, normal_cn: 0, normal_overseas: 10, normal_edu: 2}` |
| Chenyu (ramping) | `{strong: 0, normal_cn: 6, normal_overseas: 0, normal_edu: 0}` |

Admin can update the table any time; takes effect from the next day's seed. For one-off overrides (Yujie out tomorrow → set her to 0 just for Friday), admin clicks "Override tomorrow" → writes a one-shot row.

Reps with `role='admin'` who have no `sender_email` configured are auto-excluded from quota assignment (fixes today's known bug where admins get phantom send missions).

### 3. Allocation cron — `/api/missions/allocate-leads`

**Schedule:** the existing `heuristic-seed` cron runs at `0 2 * * *` (10:00 Beijing), which is too late for a morning allocation. We change both crons:

- `heuristic-seed`: `0 23 * * 0-4` (Sun–Thu 23:00 UTC = Mon–Fri 07:00 Beijing). Creates today's missions from `rep_daily_quotas`.
- `allocate-leads` (new): `0 1 * * 1-5` (Mon–Fri 01:00 UTC = Mon–Fri 09:00 Beijing). Reads today's missions and assigns leads.

That gives admin a 2-hour window (07:00–09:00 Beijing) to review/override quotas before the day's allocation locks in.

**Auth:** `Bearer $CRON_SECRET` (same as existing crons).

**Algorithm:**

```
for each rep with an active kind='send' mission for today (status='active'):
  scope = mission.scope.per_pool  // {strong: 3, normal_cn: 0, ...}
  for pool_key, n in scope:
    if n == 0: continue
    candidates = v_lead_pool
                  .where(pool_key = pool_key)
                  .order_by(priority_score DESC, created_at DESC)
                  .limit(n)
    where priority_score =
       (CASE WHEN pool_key='strong' AND lead.matched_directions ∩ mission.direction_priority THEN 100 ELSE 0 END)
     + (citation_count / 1000)  // tie-break by influence
    UPDATE pipeline_leads SET assigned_rep_id = rep.id WHERE id IN (candidates)
    INSERT INTO allocation_log (mission_id, rep_id, due_date, pool_key, lead_ids, allocator)
```

**Idempotency:** if the cron is re-run on the same day, it skips reps whose mission already has an `allocation_log` row for today.

**Underflow handling:** if a sub-pool has fewer leads than the target, allocate what exists and emit a Lark DM to admin: `"normal_cn underfilled today: Yujie wanted 12, only 4 available. Want me to draw from normal_edu?"` Admin can respond with a `record_admin_request` or just go to `/admin/allocation` and manually fill.

**Overflow / no mission:** reps without an active send mission get zero leads that day. The pool stays full; nothing rots — tomorrow's run picks them up.

### 4. Allocation log table

```sql
CREATE TABLE allocation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid REFERENCES missions(id),
  rep_id integer NOT NULL REFERENCES sales_reps(id),
  due_date date NOT NULL,
  pool_key text NOT NULL,
  lead_ids uuid[] NOT NULL,
  allocator text NOT NULL,         -- 'cron' | 'admin:{rep_id}'
  reason text,                     -- optional, for admin overrides
  notification_status text,        -- NULL=not attempted, 'sent', 'failed', 'skipped_no_lark'
  notification_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_allocation_log_due_date ON allocation_log(due_date DESC);
CREATE INDEX idx_allocation_log_rep ON allocation_log(rep_id, due_date DESC);
```

This is the **audit trail** for "why did Yujie get these 12 leads today." It also makes idempotency cheap (`SELECT 1 FROM allocation_log WHERE mission_id = ? AND due_date = today`).

### 5. Import route change

`src/app/api/pipeline/import/route.ts`:

**Before** (lines 249–254, 329):
```ts
const assignedRepId = assignRep(config, leadTier, email, matchedDirections);
// ...
assigned_rep_id: assignedRepId,
```

**After:**
```ts
// Assignment deferred to /api/missions/allocate-leads cron.
// We still classify so the pool view can partition correctly.
// assignRep() is no longer called here.
// ...
assigned_rep_id: null,
```

**Draft pre-render:** the Python scanner today writes a baseline `draft_html` so reps see something instantly. With deferred assignment, that draft won't have a rep name yet. Two options:

- **Option α** (recommended): leave draft pre-render in Python, but with `{{REP_NAME}}` / `{{REP_WECHAT}}` as literal placeholders. At allocation time, kick the draft-queue worker to re-render. The existing auto-route logic in `/api/config/assignment` (lines 122–133) already nulls draft_html when rep changes — same mechanism.
- **Option β**: Python skips draft pre-render entirely; draft-queue worker renders only after allocation. Cleaner but reps lose the "see drafts immediately" experience for newly-imported leads.

We pick **α** because it preserves UX continuity. Migration step §10 covers re-rendering existing drafts that have literal `{{REP_NAME}}` left over.

### 6. New-rep ramp logic (Chenyu)

Ramping is now **admin policy expressed through `rep_daily_quotas`** — admin manually sets Chenyu's quota lower in week 1, raises it in week 2, etc. There is no automatic ramp formula in code.

**Why manual:** the auto-inferred `clamp(ready_count, 5, 12) * rampFactor` was a guess about what's healthy for a new rep. The real answer depends on how Chenyu is actually doing — admin observes (or asks Leon "how is Chenyu's first week going?") and adjusts the quota. The system shouldn't pretend to know this.

**Helper for admin:** the `/admin/missions` daily-quota panel shows each rep's `created_at` next to their name and surfaces a soft suggestion: `"Chenyu joined 20 days ago — consider ramping to full quota soon."` Suggestion only; admin types the number.

### 7. Mission UI fix — rep-facing

#### 7.1 Sidebar link

`src/components/sidebar.tsx` `mainNav` array:

```ts
const mainNav = [
  { href: "/",         label: t("nav.overview"), Icon: OverviewIcon },
  { href: "/missions", label: t("nav.missions"), Icon: MissionsIcon, badgeKey: "missions_incomplete" as const },  // ◀── new
  { href: "/pipeline", label: t("nav.pipeline"), Icon: PipelineIcon, badgeKey: "ready" as const },
  { href: "/emails",   label: t("nav.emails"),   Icon: EmailsIcon,   badgeKey: "unread" as const },
];
```

`/missions` is placed second — above `/pipeline` — so the order matches the daily routine: see today's plan → work the pipeline → check email replies. Badge shows `incomplete_count`.

`t("nav.missions")` = `"今日"` (Chinese) / `"Today"` (English). Mission iconography is a check-square or target.

The sidebar `badges` endpoint (`/api/sidebar/badges` or wherever counts come from — to be located in plan phase) adds a `missions_incomplete` count.

#### 7.2 `MissionsDot` empty-state

`src/components/missions-dot.tsx` currently hides when `total = 0`. Change:

- If `total > 0 && incomplete > 0` → show red dot + "Missions 5/8"
- If `total > 0 && incomplete == 0` → show green check + "All done" (visible, celebratory)
- If `total == 0 && user_is_new` (created_at < 7d ago) → show grey "今日任务即将出现" linking to `/missions` (which shows an empty-state explainer)
- If `total == 0 && user_is_not_new` → still hide (don't annoy veterans on a quiet day)

#### 7.3 `/pipeline` mission banner

Top of `/pipeline` (above the stat strip), a thin banner:

```
┌──────────────────────────────────────────────────────────────┐
│ ✅ Today: 5 of 8 sends · 2 of 5 replies · Focus: 强势学校优先 → │
└──────────────────────────────────────────────────────────────┘
```

Click the banner → `/missions`. Click "Focus" → `/congress/{run_id}` (reuses team_focus's congress link). If no active missions, banner is hidden (don't show empty state on /pipeline; that's `/missions`'s job).

#### 7.4 `/missions` empty-state

When `my_today.length === 0`:

- If admin hasn't approved this week's missions → "Missions for this week are awaiting admin approval. Ping admin in Lark or check back."
- If no missions exist at all → "No missions for today. The seeder runs at 07:00 Beijing daily."

These messages are static; no new API needed.

### 8. Mission UI fix — admin-facing

#### 8.1 Sidebar link

`toolsNav` adds (admin-only):

```ts
{ href: "/admin/missions", label: t("nav.adminMissions"), Icon: AdminMissionsIcon, adminOnly: true },
```

#### 8.2 `/admin/allocation` — new page

A daily allocation cockpit. Sections:

- **Pool inventory** — counts per sub-pool: strong (12), normal_cn (47), normal_overseas (28), normal_edu (3)
- **Today's allocations** — table: rep | mission target | per-pool breakdown | allocated count | "Re-allocate" button
- **Pending allocation** — if cron hasn't run yet, "Will run at 09:00 Beijing" + "Run now" button
- **Underfill warnings** — pulled from cron output

Per-rep "Re-allocate" opens a modal: edit `per_pool`, save → POSTs to `/api/admin/allocation/override` which:
1. Returns previously-allocated leads to the pool (`assigned_rep_id = NULL`)
2. Re-runs the allocation algorithm for that rep only
3. Inserts a new `allocation_log` row with `allocator = 'admin:{rep_id}'` and `reason`

#### 8.3 `/admin/missions` — daily-quotas panel (new section on existing page)

A table at the top of `/admin/missions`:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Daily quotas — applies every weekday until changed                          │
├──────────┬────────┬───────────┬──────────────────┬─────────────┬────────────┤
│ Rep      │ Strong │ Normal CN │ Normal Overseas  │ Normal EDU  │ Total/day  │
├──────────┼────────┼───────────┼──────────────────┼─────────────┼────────────┤
│ Leo      │   8    │    0      │       0          │     0       │     8      │
│ Yujie    │   0    │   12      │       0          │     0       │    12      │
│ Ethan    │   0    │    0      │      10          │     2       │    12      │
│ Chenyu * │   0    │    6      │       0          │     0       │     6      │
└──────────┴────────┴───────────┴──────────────────┴─────────────┴────────────┘
* joined 2026-04-23 (20 days ago) — consider ramping toward full quota

[Save quotas]   [Override tomorrow only ↗]
```

- Each cell is a number input. "Save quotas" POSTs to `/api/admin/missions/quotas` which upserts `rep_daily_quotas` rows.
- "Override tomorrow only" opens a one-day modal that writes to `rep_daily_quotas_override` (table per §10, with `due_date` column).
- Below the table: today's allocation status — "Today's allocation ran at 09:01 Beijing. Yujie got 12/12, Ethan got 8/12 (normal_overseas pool underfilled)."

This panel is the **primary action surface** for admin under this design. The quarterly/weekly/proposed-missions sections below it are unchanged from today.

### 9. Onboarding integration

`src/lib/onboarding.ts`, `sendWalkthrough()`:

Update **Message 2** (lines 788–804) to add `/missions` first in the page list:

```ts
const dashboardMsg = `**Dashboard**: ${DASHBOARD_URL}
登录邮箱: ${email}
密码: 就是你刚才在这跟我设的那个.

登进去之后看这几个页面就够了:
  • /missions — 今天该做什么. 每天早上 9 点系统给你分今天的 lead (我会在 Lark DM 你), 这页告诉你今天的目标和进度.   ◀── new, first
  • /pipeline — 你的 lead 在这. 系统按今天分配给你的 lead, AI 已经帮你拟好邮件草稿, 你看一眼 OK 就点 Send.
  • /emails — 邮件追踪. 谁打开了 / 谁回了.
  • /inbox — 客户回信. (我会在收到新回复时主动 DM 你提醒.)

**重要**: 我 (Leon) 不只在 Lark. ...`;
```

Update **Message 4** (lines 852–887) to add a mission-related example to "怎么使唤我":

```
  • "今天的任务是什么?"  → 我会告诉你今天的目标 + 进度
```

This requires `src/lib/lark-agent.ts` / helper-tools to support a `get_my_missions_today` tool — straightforward read of `/api/missions`.

### 10. Migration sequencing & rollback

**Migration 070** (sequential — 069 is current latest):

1. Add `allocation_log` table (additive — safe)
2. Add `v_lead_pool` view (additive — safe)
3. Add `rep_daily_quotas` table — standing per-rep per-pool daily quota:
   ```sql
   CREATE TABLE rep_daily_quotas (
     rep_id integer PRIMARY KEY REFERENCES sales_reps(id) ON DELETE CASCADE,
     per_pool jsonb NOT NULL DEFAULT '{}'::jsonb,
                    -- e.g. {"strong":8,"normal_cn":0,"normal_overseas":0,"normal_edu":0}
     direction_priority text[] DEFAULT ARRAY[]::text[],
     updated_by_rep_id integer REFERENCES sales_reps(id),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   ```
4. Add `rep_daily_quotas_override` table — one-day exceptions:
   ```sql
   CREATE TABLE rep_daily_quotas_override (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     rep_id integer NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
     due_date date NOT NULL,
     per_pool jsonb NOT NULL,
     reason text,
     created_by_rep_id integer REFERENCES sales_reps(id),
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE(rep_id, due_date)
   );
   ```
5. No changes to `pipeline_leads` schema
6. No changes to `missions` schema; `scope` JSONB is already there, we just start writing structured content

**Seed step:** at migration apply time, write a one-time `rep_daily_quotas` row for each current rep mirroring today's effective routing (Leo all-strong, Yujie all-cn, Ethan all-overseas, Chenyu small-cn) so the system is functional on day 1 without admin first having to go set quotas.

**Rollout phases:**

**Phase 1 (shadow):** allocation cron runs but **doesn't write** `assigned_rep_id`. It writes `allocation_log` only. Compare proposed allocations against actual `assigned_rep_id` set by current import logic. Run for 3–5 days to validate fairness in real data.

**Phase 2 (flip):** import route stops calling `assignRep()`. Allocation cron starts writing `assigned_rep_id`. Leads imported before this point keep their existing `assigned_rep_id` (no retroactive un-assignment). From the flip moment forward, new imports land with `assigned_rep_id IS NULL` and are picked up by the next morning's allocation.

**Phase 3 (cleanup):** delete dead routing code paths in `src/lib/assignment.ts` that are no longer reachable (the `assignRep()` function survives because it's still useful for admin "auto-route now" actions; the direction-override map can be retired).

**Rollback:** if Phase 2 produces bad allocations:
- `DELETE FROM allocation_log WHERE due_date = today AND allocator = 'cron'` — purely informational
- Restore import route's `assignRep()` call (single-commit revert)
- Run `/api/config/assignment` POST to retroactively assign the un-allocated leads via the legacy rules

Rollback time: under 10 minutes (one commit revert + one admin POST).

### 11. Notifying reps that their leads are ready

Allocation is system-driven, so without a notification step a rep would only know they have new leads by checking `/missions` or `/pipeline`. That defeats the goal of making the daily routine legible.

**Notification channels (in priority order):**

1. **Lark DM from Leon** — primary. Sent within 60s of allocation cron completing. Per-rep, with the actual numbers:
   ```
   早上好 Yujie 👋

   今天给你分了 12 条 lead, 都在 /pipeline 等着. 都已经 AI 拟好草稿了, 你看一眼 OK 就 Send.

   分布:
     • normal_cn: 12 条

   今天 focus: 强势学校优先 (本周 team_focus)

   开始: https://calistamind.com/pipeline
   今日任务: https://calistamind.com/missions
   ```

   - If pool was underfilled (rep wanted 12, got 8), the DM says so transparently: `"今天 normal_cn 池子里只有 8 条新的, 你拿了 8 条. 其余的明天再补."`
   - If rep has zero allocation today (quota was 0 or pool was empty), no DM — silence is fine, don't spam.
   - Implementation: allocation cron, after writing `allocation_log` rows, enqueues Lark DMs via the same `sendLarkDM(rep_id, text)` helper Leon already uses. Each DM is `try/catch`'d so one rep's failure doesn't block others.

2. **Dashboard MissionsDot** — secondary. The dot auto-refreshes (polls every 60s) so a rep who's already in the dashboard will see the count tick up to today's target shortly after allocation runs. No code change needed beyond the empty-state fix in §7.2.

3. **`/pipeline` banner** — also secondary, same mechanism. Banner pulls from `/api/missions`.

**What the rep is NOT notified about:**
- Mid-day admin overrides — too noisy. If admin reallocates Yujie's leads to Ethan at 14:00, no second DM. Admin tells them in Lark group separately if needed.
- Other reps' allocations — `/missions` already shows team_today; no DM needed.

**Failure handling:**
- If the Lark DM API is down, allocation is **still considered successful** (leads are assigned, mission progress is tracked). A row goes into `allocation_log.notification_status = 'failed'` for retry. The cron has a `--retry-notifications` mode that resends any failed DMs from the last 24h.
- If a rep's `lark_user_id` is null (rep set up without Lark), notification is skipped silently. Admin sees an `/admin/allocation` warning: `"Ethan has no Lark linked — won't get morning DMs. Configure at /admin/reps/{id}."`

**Verification (success criterion):** after each daily cron run, `SELECT count(*) FROM allocation_log WHERE due_date = today AND notification_status = 'sent'` should equal `count(*) FROM allocation_log WHERE due_date = today AND notification_status IS NOT NULL`. Monitored as part of cron heartbeat.

### 12. Out-of-scope (deferred)

These showed up during design but are not in this spec:

- **Reply-mission bumping.** `bumpMissionProgress` is wired for `send`, `mark_wechat`, but not `reply`. Tracked separately.
- **Cherry-pick lane.** A small "free pool" sub-allocation (e.g., 10% of strong leads) that any rep can self-claim — a future enhancement once base system is stable.
- **Cross-team allocation.** If team grows beyond Leo/Yujie/Ethan/Chenyu, the sub-pool taxonomy may need rethinking. Out of scope.

## Success criteria

After deployment, with one week of real data:

1. **Fairness:** Per-day allocation counts per rep are within 25% of their `mission.target`. (Today: counts swing 10× day-to-day.)
2. **Visibility:** `/missions` page hits from rep accounts > 1 per logged-in day per rep (measured via app logs).
3. **Onboarding signal:** New rep onboarded after launch reports they understood the daily workflow within first week (qualitative — ask Chenyu after the change lands).
4. **No regression in send volume:** Weekly send count within 10% of pre-launch baseline.
5. **No regression in attribution:** Conversion credit (`marked_by_rep_id`) still flows correctly. Sample-check 5 conversions per week.

## Open questions for review

1. **Allocation timing.** 09:00 Beijing is the default. Should there be a second allocation pass at 14:00 Beijing for reps who finished morning batch early? (My instinct: no, keep simple; reps with empty queue can `record_admin_request` Leon to top them up. But worth confirming.)
2. **Strong-pool sharing.** Today all strong → Leo. Under this design, default scope keeps that. But should Leo's overflow strong leads (when Leo's mission target < strong pool size) auto-spill to Yujie/Ethan, or stay in the pool for tomorrow? (My instinct: stay in the pool — strong leads are the highest-value, no reason to send them in haste.)
3. **`matched_directions` overrides.** Today's config has ~20 direction overrides that route to Leo regardless of tier. Under sub-pools, this collapses to "strong pool prioritizes direction-matched leads first." Are there directions that should still force routing to a specific rep regardless of pool? (Probably no — but flag if yes.)
