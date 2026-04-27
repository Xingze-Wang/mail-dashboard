# Plan: never let email + data go wrong silently again

This is a concrete plan, ordered by leverage. Each item is grounded in a specific incident we already hit (referenced by commit SHA where useful). The goal is not to prevent every possible bug — it is to ensure that when something does break, **it breaks loudly instead of silently, and the system tells us what's wrong before a user does.**

## What "going wrong" actually meant in practice

From the last ~50 commits, every data incident we shipped a fix for falls into five families. They're worth naming because the fixes for each family look very different.

1. **Silent truncation** — a query hit a time/page/rate-limit cap, returned partial results, the UI rendered them as truth. Examples: metrics showed 281 sent instead of 1382 (`10fa4e3`); body search returned 0 hits because postgrest `.or()` doesn't translate `%` (`e8f8e18`).
2. **Monotonic-status undercount** — `emails.status` only stores the latest event, so click-then-complain emails stopped counting as clicks. Same shape: `pipeline_leads.status='replied'` was queried in 5 places but written nowhere (`acd2c17`); WeChat scoped by lead-owner not actor (`32e3f6e`).
3. **Schema/ID drift across modules** — two writers used different fields for the same concept (`name` vs `sender_name`, `assigned_rep_id` vs `marked_by_rep_id`, `created_at` vs `corrected_at`). Each fix landed in isolation, so the next module re-introduced the same confusion.
4. **Missing backfill** — a new column was added to the schema but historical rows kept `NULL`, so the new code path returned empty results forever (1100+ legacy emails with no body, inbound rows with no `rep_id`, WeChat marks pre-attribution).
5. **Fire-and-forget swallowed errors** — UI mutation calls without `res.ok` checks, `.catch(() => {})` on critical posts, try/catch that returned `{ ok: true }` regardless. The dashboard celebrated; the DB stayed unchanged.

Every one of these was invisible. The dashboard kept rendering. No alert fired. We only found out because a user noticed a number looked wrong.

The plan below attacks these five families directly.

---

## Tier 0 — current visible gap (do first)

**Webhook events table is empty.** 0 rows ever. Either Resend isn't sending webhooks to us, signature verification is silently rejecting, or our endpoint is 401-ing. Until this is fixed, real-time status updates depend entirely on the daily cron sync.

Action items, in order:

1. Add a `/api/webhook/health` page that shows: total `webhook_events` rows, most-recent timestamp per `type`, and a hard banner when latest > 24h old. (Already partly built — surface it.)
2. Test Resend → our `/api/webhook` endpoint manually with a curl with the right HMAC. Confirm we accept it. If we don't, fix signature verification.
3. Confirm in Resend dashboard that the webhook URL points at `https://qiji-pipeline.vercel.app/api/webhook` and is active.
4. Once events flow, add a daily check: if `webhook_events.created_at > now() - 24h` returns 0 rows AND we sent emails today, fire an admin alert. **The system should know its own ears are broken.**

---

## Tier 1 — make truncation impossible to miss

The class-of-bug fix here is: **any query that could return partial results must say so on the response, and any UI that renders such a response must show that fact.**

1. **Standard "this query was capped" envelope.** Every list/aggregate API response that paginates or applies a row cap returns an extra field: `{ truncated: false, scannedTotal: N, requestedTotal: M }`. If `truncated=true`, the UI must render a visible "showing X of Y" hint with a button to fetch the rest. Already done for `metrics.scannedEmails` — extend to `/api/emails`, `/api/inbound`, `/api/pipeline`, `/api/scorer/*`.
2. **No silent caps in cron jobs.** Every cron step that has a max-pages or time-budget guard must log the result back into `results` with a `complete: bool`. The cron health page must surface incomplete runs in red. Already done for `syncFromResend` — audit the rest.
3. **Banned pattern: silent fallback to a different source.** If we ever fall back from "live Resend" to "DB cache" or vice versa, the response includes `_source` and the UI shows it ("data from DB cache, last refreshed 2h ago"). Right now we have `_source` on metrics — make it required on every read endpoint that has more than one possible source.

---

## Tier 2 — kill the monotonic-status class of bug forever

The root cause is that `emails.status` is a *latest-event-wins* field, and every analytics query that asked "did this ever click?" got the wrong answer when the email later complained or bounced. We've patched 5+ specific instances. The structural fix:

1. **Treat `webhook_events` as the canonical event log.** It's already there, schema is right, indexes exist. Once Tier 0 is fixed and events actually flow, every "did X ever happen?" question goes through `webhook_events`, not `emails.status`.
2. **Add a SQL view `email_history`** that joins `emails` to `webhook_events` and gives the boolean array `(was_delivered, was_clicked, was_bounced, was_complained)`. All metrics route through this view. `emails.status` becomes "what's the email's current state for the inbox UI" — never used for counts.
3. **Lint rule (or CI grep) banning `eq("status", "clicked")`** in any new code outside `src/app/inbox/*`. Forcing reviewers to use the view eliminates the class of bug.

---

## Tier 3 — kill schema/ID drift across modules

Eight separate commits in the last month either renamed a column reference or added a fallback because two modules used different fields for the same concept (`name` vs `sender_name`, `assigned_rep_id` vs `marked_by_rep_id`). The fix:

1. **One DTO file at the seam.** `src/lib/dto.ts` already exists for some shapes — extend it to be authoritative. Every query result that gets returned from an API route or read by another module gets normalized through `dto.toRep(row)`, `dto.toLead(row)`, `dto.toEmail(row)`. Field-name confusion gets caught at one layer instead of every consumer.
2. **Banned-fields list in code review.** `pipeline_leads.assigned_rep_id` is for routing, not attribution. Reviewers should reject any PR that uses it for "who did X". This is documented in CLAUDE.md but enforcement is by humans — promote to a CI grep that flags suspicious patterns (e.g. `assigned_rep_id` in a file path matching `metrics|analytics|stats`).
3. **Schema diff alert.** Any time a migration adds/renames a column on `emails`, `pipeline_leads`, `sales_reps`, `brief_lookups`, `inbound_emails`, or `webhook_events`, an automated PR comment lists every place in code that references the old name. Use `tsc --noEmit` on the post-rename codebase to find errors and post them as PR comments.

---

## Tier 4 — backfill is part of "shipping the column"

Every time we added a new column, we landed code that read from it but didn't fill historical rows. The pattern:

1. **Migration template requires a backfill plan.** Any migration that adds a non-nullable concept (even if the column is technically nullable) must include either: (a) a one-shot SQL `UPDATE` to set the value for existing rows, or (b) a documented backfill route in `/api/*/backfill-*` that admin can call. We already have backfill routes for `inbound.rep_id`, `emails.text/html`, `pipeline_leads.author`, etc. Make a `migrations/MIGRATION_TEMPLATE.md` that requires the backfill section.
2. **Coverage check on cron.** Daily cron logs `{ column: emails.text, populated: 1382, null: 0 }` for each "should be filled" column. When coverage drops, alert. (E.g., if a new send code path forgets to write `text`, we catch it in 24h instead of finding 200 unsearchable emails 2 months later.)
3. **No new feature without "what about the old rows?"** Code review checklist: every PR that adds a read of `column X` must explain how `column X` got populated for rows older than the PR. If the answer is "it didn't," reject until a backfill is in the PR.

---

## Tier 5 — error handling that can't be skipped

We've shipped at least 4 fixes for fire-and-forget mutations (`43fdad3`, `5c38916`, `a31a3a2`, `b487051`). The fix pattern is mechanical and easy to enforce:

1. **Wrap every `fetch(POST/PATCH/DELETE)` in a typed helper** (`src/lib/api-client.ts`) that throws on `!res.ok`. Then the only way to suppress an error is an explicit `try/catch` — which is grep-able and code-reviewable. `.catch(() => {})` on a fetch call is now an obvious smell.
2. **Server-side: one error-response helper.** Every `NextResponse.json({ ok: false, ... })` goes through a helper that requires a `code` field, logs to console.error with the same id, and returns a structured envelope the client can type-check.
3. **Lint: ban `Promise.catch(() => {})` and bare `try { } catch { }` empty blocks** in `src/`. They're almost always wrong; the few legitimate uses (e.g. best-effort enrichment) get an explicit `// best-effort: ok to swallow because Y` comment.

---

## Tier 6 — observability so we hear it before users do

Even with all of the above, things will still go wrong. The point is to learn about it from a number, not a user.

1. **Daily integrity report.** A cron that runs the audit script I just used (`emails.thread_id null count`, `inbound.rep_id null count`, `webhook_events most-recent timestamp`, `wechat marks with no actor`, etc.) and posts results to admin's helper-bot opener. If any number changes meaningfully, it leads with that.
2. **One admin dashboard tile per integrity invariant.** Each tile is green when the invariant holds, yellow when it's drifting, red when broken. Today's invariants: 100% emails have `resend_id`, 100% inbound have `rep_id` (or known-legacy), 100% wechat marks have `marked_by_rep_id` going forward, webhooks fired in last 24h, cron sync `complete=true` last run, every active rep has a `sender_email`.
3. **Alarm on rate changes, not just absolute thresholds.** Click rate week-over-week drop ≥40% already alerts (`admin-alerts.ts`). Extend: send-rate drop ≥50%, inbound-rate drop ≥80%, WeChat-mark-rate drop ≥80%. A *zero* on a previously-non-zero metric is the loudest possible signal that something upstream is broken.

---

## What "done" looks like

A single command — `pnpm integrity` — that runs the audit script, prints all invariants in red/yellow/green, and exits non-zero on red. Cron runs it daily and ships the result to admin. The day someone reports "the dashboard looks wrong," that command should already be red (because we caught it before they did) or stay green (because they're misreading the dashboard, not the data).

We are not there yet. The order to get there:

- This week: **Tier 0** (webhook health), then expand the existing `_source` envelope from metrics to every list endpoint (Tier 1.3).
- Next week: **Tier 2** (`webhook_events` as canonical, view + lint rule), and a `pnpm integrity` script that runs the audit (Tier 6.1).
- Within two weeks: backfill template + coverage check on cron (Tier 4), error-helper migration (Tier 5).
- Ongoing: every new migration follows the new template; every new read endpoint emits `_source` and `truncated`.

That's the plan. None of it is exotic. The reason data went wrong is that we shipped each piece in isolation and trusted that the integration would hold. The fix is to make the integration *itself* the thing that's monitored.
