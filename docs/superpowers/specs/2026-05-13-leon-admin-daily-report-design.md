# Leon admin daily report + admin-action framing

**Date:** 2026-05-13
**Author:** Xingze (with Claude)
**Status:** Draft

## Problem

Two related problems with Leon today, both rooted in the same gap:

### 1. Daily standup is not useful for admin

The existing `/api/cron/standup` (runs `0 1 * * 1-5` UTC = 09:00 Beijing weekdays) sends each rep a **per-rep** DM with three metrics: `ready` queue depth, inbound replies (24h), WeChat marks (7d). It's motivational and forward-looking — fine for sales reps.

**Admin gets the same per-rep DM** about their own (likely empty) queue, plus no org-wide visibility. So admin's morning Lark surfaces *zero* signal about how the team is doing. What admin actually needs (verbatim from the user):

- Emails sent total + by rep
- All rates total + by rep (open, click, reply, bounce)
- How reps are using AI (verbatim acceptance, edit distance, top edit reasons)
- "Anything I need to be aware of" (integrity reds, missing quotas, stale wechat marks, drift)

### 2. Leon doesn't act confidently on admin requests

Leon already has action tools (`batch_send`, `reassign_lead`, `reassign_leads_bulk`, `redraft_lead`, `bulk_flag`, `build_rep_template`, `flag_lead`, `skip_lead`, `redraft_lead`). They work. But the system prompt frames Leon as a **supporter / 老师傅** ("memory `feedback_helper_design`: don't be a task-master; show data, don't act"). That framing limits action-use even when admin asks for it.

Result: admin says "reassign all of Jinyang's overseas leads to Ethan" and Leon **describes what would happen** instead of doing it. Or Leon does one and stops because `MAX_ITERATIONS = 3` ran out.

### Why these are one feature

Both are "Leon's mode of operation when DM-ing with admin role." The standup is *Leon proactively reporting at 9 AM*. Admin actions are *Leon responding when admin DMs*. They share:
- Same Lark transport
- Same lark-agent loop
- Same set of read tools (Leon needs the same numbers to report at 9 AM as he does to answer admin questions)
- Same audit need (every action Leon takes on admin's behalf should be inspectable later)

Treating them as one feature lets us add metrics once, expose them via a daily report AND via on-demand DMs.

## Goals

1. **Replace the admin's per-rep standup with an admin-specific daily report** at the same 09:00 Beijing tick, showing org-wide volume + rates + AI usage + alerts
2. **Make Leon execute admin-action tools confidently** when admin asks, with audit trail
3. **Bump `MAX_ITERATIONS` for admin role** so multi-step work (find + reassign + redraft) finishes in one DM
4. **No new schema** — reuse `lark_messages` for audit, reuse existing read tools for metrics
5. **Keep sales-rep standup unchanged** — that motivational framing works for them; don't touch it

## Non-goals

- **Not the skill registry** — Rung 2 from prior conversation. Saved for after this lands.
- **Not approval cards for destructive actions** — `batch_send > 5` confirmation cards are valuable but not in this scope. Use audit trail + admin's existing ability to DM "stop / undo" instead.
- **Not changing the sales-rep standup format** — they're getting useful DMs already; the friction is admin-only.
- **Not adding new tools** — Leon's 12 action tools are enough. The fix is framing + iterations, not capability.
- **Not building a separate `/admin/daily-report` web page** — admin's day starts in Lark. Web page is a future enhancement if signal demands it.

## High-level architecture

```
Existing 09:00 Beijing cron (/api/cron/standup)
  │
  ├──> sales reps: existing per-rep "you have X to do" DM (unchanged)
  │
  └──> admin reps: NEW org-wide daily report DM (this work)
          ├ org volume (sent / clicked / replied / wechat — yesterday + week)
          ├ per-rep table (sent | open% | click% | reply%)
          ├ AI usage (verbatim accept %, median edit distance, top edit reasons)
          ├ alerts (integrity reds, missing quotas, stale wechat, allocation underfills)
          └ "ask me to do X" hint (reminds admin Leon has action tools)


Existing Lark DM flow (processInboundLarkMessage)
  │
  ├ existing path: read tools → answer
  │
  └ NEW for admin role only:
          ├ MAX_ITERATIONS = 8 (was 3 for everyone)
          ├ system prompt addendum: "you have action tools; use them
          │   when admin asks; large batches DM before doing"
          ├ audit row: every ACTION_TOOL call writes to lark_messages
          │   with role='action' (new role value) and structured args
          └ admin can ask "what did you do today?" → Leon reads
            recent role='action' rows
```

## Detailed design

### 1. Admin daily report — format

Sent to each rep with `role='admin'` at 09:00 Beijing weekdays, replacing their per-rep standup. Message structure (Chinese, matches existing standup tone but informational, not motivational):

```
📊 早安 — 今日 admin report

**昨天 (org-wide)**
  发送: 47 封 · 打开: 22 (47%) · 点击: 8 (17%) · 回复: 3 (6%)
  微信新加: 1

**本周累计 (周一 → 今天)**
  发送: 198 封 · 打开: 89 (45%) · 点击: 31 (16%) · 回复: 14 (7%)
  微信新加: 5

**按 rep 看 (昨天)**
  Yujie:   24 发, 12 开 (50%), 5 点 (21%), 2 回, 1 wx ✓
  Ethan:   15 发,  6 开 (40%), 2 点 (13%), 1 回
  Jinyang:  8 发,  4 开 (50%), 1 点 (13%), 0 回
  Leo:      0 发 (strong pool 空)

**reps 怎么用 AI (本周)**
  Yujie:   逐字接受 18% · 中位编辑距离 287 字 · 主要原因 "too_verbose"
  Ethan:   逐字接受 53% · 中位编辑距离  42 字 · 主要原因 "individual_taste"
  Jinyang: 逐字接受  9% · 中位编辑距离 412 字 · 主要原因 "tone_off"
  → Jinyang 编辑量明显偏高, 可能 template 需要调整

**需要你注意**
  ⚠️ Leo 今天 quota=8 但 strong pool 只有 1 条
  ⚠️ 3 个 wechat mark 超过 14 天没跟进 (Yujie 2, Ethan 1)
  ✅ 集成检查全部通过

**有什么要我做**
  DM 我就行, 例如:
    • "把 Jinyang 今天的 overseas lead 转给 Ethan"
    • "今天的 strong lead 全部 redraft 一遍"
    • "Yujie 加微信 wang@xxx" / "Ethan 加微信 li@xxx"
    • "你今天做了什么"  → 我会列出今天帮你做过的操作
```

**Length:** ~30 lines. Admin scans in 20 seconds. Each section is skippable. The "需要你注意" section is the high-signal one — it surfaces things that need a decision today.

### 2. Source for each metric

| Metric | Source | Computed how |
|---|---|---|
| Sent (yesterday / week) | `emails` where `created_at` in range | `count(*)` grouped by date or actor_rep_id |
| Open % | `webhook_events` type='email.opened' | distinct email_ids / sent |
| Click % | `webhook_events` type='email.clicked' | distinct email_ids / sent |
| Reply % | `inbound_emails` where `source_email_id IN sent_emails.id` | distinct source_email_id / sent |
| WeChat new (24h) | `brief_lookups` where `added_wechat=true AND wechat_at > yesterday_start` | `count(*)` |
| Per-rep sent | `emails.actor_rep_id` group by | `count(*) WHERE actor_rep_id=rep AND created_at > yesterday_start` |
| Verbatim accept % | `pipeline_leads` where `status='sent' AND draft_edit_distance <= 5` | `count / total_sent_this_week` per rep (≤5 = "essentially verbatim", accommodates whitespace + tiny tweaks) |
| Median edit distance | `pipeline_leads.draft_edit_distance` where status='sent' this week | per-rep median |
| Top edit reason | `pipeline_leads.edit_reasons` unnested | mode per-rep |
| Quota vs pool warning | `rep_daily_quotas.per_pool` vs `v_lead_pool` counts per `pool_key` | for each rep, if `quota.X > pool.X` flag it |
| Stale wechat mark | `brief_lookups.wechat_at` where `> 14d ago AND no follow-up event` | reuse `getStaleWechatFollowups()` |
| Integrity report | `runIntegrity()` from `src/lib/integrity-checks.ts` (called by `get_integrity_report` tool) | reuse, report only counts not full red list |

### 3. New helper: `buildAdminDailyReport`

Lives at `src/lib/admin-daily-report.ts`. Single export: `buildAdminDailyReport(): Promise<string>` returning the formatted message text. Internal helpers fetch each section. Failures in any section degrade gracefully (line shows "—" instead of throwing).

```typescript
export async function buildAdminDailyReport(): Promise<string> {
  const [
    orgYesterday,
    orgWeek,
    perRepYesterday,
    aiUsageWeek,
    alerts,
  ] = await Promise.all([
    fetchOrgMetrics(yesterdayRange()),
    fetchOrgMetrics(weekRange()),
    fetchPerRepMetrics(yesterdayRange()),
    fetchAiUsage(weekRange()),
    fetchAlerts(),
  ]);
  return renderMessage({ orgYesterday, orgWeek, perRepYesterday, aiUsageWeek, alerts });
}
```

### 4. `/api/cron/standup` route diff

Existing structure: loops over all active reps, generates per-rep message, sends DM. Change:
1. Before the loop, check if the rep's `role === 'admin'`. If yes, build + send admin daily report instead of the per-rep message.
2. Wrap the admin report build in `try/catch` so a failure doesn't block sales-rep standups.
3. Bot still logs `lark_messages` row on success for audit.

No other changes to the standup file.

### 5. Lark-agent admin-action framing

`src/lib/lark-agent.ts`:

**A. Bump iterations for admin:**
```typescript
const MAX_ITERATIONS = session.role === "admin" ? 8 : 3;
```

**B. Add an admin-prompt addendum** appended to `SYSTEM_BASE` when `session.role === 'admin'`:

```
## 你正在跟 admin 对话

Admin 找你不只是问数字, 他会让你做事:
  • "把 X 的 lead 转给 Y" → 用 reassign_lead 或 reassign_leads_bulk
  • "把今天 strong 全部 redraft" → 用 redraft_lead / bulk_flag
  • "给 X 发一封" → 用 batch_send
  • "加了 X 的微信" → 用 mark_wechat (通过 admin 自己的归属)
  • "你今天做了什么" → 看最近你写入的 lark_messages role='action' 行
  • "标这条 strong" / "skip 这条" → 用 flag_lead / skip_lead

规则:
  1. 真的去做, 不要只描述 ("我可以帮你 reassign..." → 直接 reassign)
  2. 单条操作直接做; >5 条批量操作先 DM 一下 "我要做 X, 共 N 条, 确认?" 再做
  3. 做完之后报告: 操作了什么, 影响了几条
  4. 失败也直接说, 不要假装成功
```

**C. Audit trail.** Wrap the action-tool dispatch (`runActionTool` in `src/lib/helper-action-tools.ts`) to log each call:

```typescript
// In lark-agent.ts after a successful action tool fires:
await supabase.from("lark_messages").insert({
  chat_id: session.chatId,
  rep_id: session.repId,
  role: "action",      // NEW role value
  text: `[action:${tool}] ${JSON.stringify(args).slice(0, 500)} → ${JSON.stringify(result).slice(0, 500)}`,
  raw: { tool, args, result, ts: new Date().toISOString() },
});
```

Constraint check: the `lark_messages.role` column has a CHECK constraint (`('user' | 'assistant')` per migration 037). We need to relax it. Migration 084 adds `'action'` and `'system'` as valid values.

### 6. Migration 084 — lark_messages role values

```sql
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
-- 'action' rows: Leon reads them when admin asks "what did you do today"
-- 'system' rows: Excluded from conversation-history loading in lark-agent
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — only future rows use the new values

ALTER TABLE lark_messages DROP CONSTRAINT IF EXISTS lark_messages_role_check;
ALTER TABLE lark_messages ADD CONSTRAINT lark_messages_role_check
  CHECK (role IN ('user', 'assistant', 'action', 'system'));
```

### 7. Two new read tools

Used by Leon when admin asks "what did you do today" / "what does today's report look like."

**`get_recent_admin_actions`** — reads `lark_messages` where `role='action'` and `created_at > start_of_today`. Returns a list of `{tool, args, result, when}` for admin to review.

**`get_admin_daily_report`** — calls `buildAdminDailyReport()` and returns the formatted text. Useful when admin asks Leon "show me today's report again" mid-day, or for testing.

Both registered in `READ_TOOL_NAMES` set in `src/lib/helper-tools.ts` and dispatched in `src/lib/helper-read-tools.ts`. Both admin-only — early-return `{error: "admin only"}` for non-admin sessions.

### 8. Edge cases

**Admin has multiple sessions / multiple chats.** Audit logging uses the session's `chat_id`; same admin DMing from two devices produces two audit rows. Acceptable.

**Action fires across `MAX_ITERATIONS` boundary.** Each round's tool calls already complete fully before the loop iterates. No partial action.

**Admin DMs at 03:00 AM and the report is stale.** The cron only runs once at 09:00. If admin wants fresh numbers at 03:00, they ask `"show me today's report"` and Leon rebuilds it on demand via `get_admin_daily_report` tool.

**No admins exist.** Cron skips the admin path entirely. Sales reps still get their standup.

**Action tool fails.** Failure is recorded in the audit row (`result.ok === false`). Leon's response reports the failure. No retry.

## Migration sequencing

- **Migration 084** (additive — relax CHECK constraint). Apply via `scripts/apply-084.mjs`.
- **No data backfill needed.**

## Rollout

Single deploy. No phases. The admin daily report kicks in at the next 09:00 Beijing tick after deploy. Roll back: revert the standup route + lark-agent commits; the migration is benign (constraint only blocks future writes, doesn't break reads).

## Success criteria

After 1 week:

1. **Admin reports the daily message is useful** — qualitative; the user is the test
2. **Admin DMs an action at least once and Leon does it (not describes it)** — verified via `lark_messages` showing both the user DM and an `action` row
3. **No silent action-tool failures** — every action row has either `result.ok === true` and a visible side-effect, or `result.ok === false` with Leon's reply explaining
4. **Sales-rep standup volume unchanged** — sample-check 2-3 reps that their morning DM still arrives and looks right

## Open questions

1. **What time exactly should the admin report fire?** Currently `0 1 * * 1-5` (09:00 Beijing). Could be earlier (08:30) to give admin time before reps wake up. I lean: keep 09:00, matches existing standup, less change.
2. **Should the admin report be posted to the team Lark group instead of DM?** Group post = team sees the admin sees the numbers (transparency). DM = admin sees first, decides what to share. I lean: DM. Admin can copy-paste the parts they want to share. Less anxiety for reps if a number looks bad.
3. **Verbatim accept threshold — `draft_edit_distance <= 5` or `<= 0`?** ≤0 is strict (only literally identical). ≤5 includes "fixed a typo." I lean: ≤5, more meaningful signal.
4. **Should `get_recent_admin_actions` filter by chat_id or by rep_id?** Same admin across two devices should see all their actions. I lean: by rep_id (admin's own id), not chat_id.

## Out of scope (deferred)

- **Skill registry** (`leon_skills` table) — Rung 2 work
- **Approval cards** for destructive batches
- **`/admin/daily-report` web page** — Lark first
- **Cross-rep skill suggestions** (Leon noticing recurring admin requests and proposing skills)
- **Sales-rep AI-usage feedback** (telling each rep their own verbatim acceptance rate) — possible follow-up
