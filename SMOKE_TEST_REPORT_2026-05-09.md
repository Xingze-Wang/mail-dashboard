# Mail App — Smoke Test Report
**Date:** 2026-05-09
**Target:** `/Users/xingzewang/Desktop/mail` (Qiji Pipeline) at `http://localhost:3001`
**Coverage:** 16 agents across 3 waves — static + dry-run live + real-QA Playwright + API fuzz + live data integrity.
**Baselines (all clean):** `tsc --noEmit` ✓ · `eslint` ✓ · `lint:integrity` ✓ · `lint:fetch` ✓

---

## TL;DR

- **One P0 production blocker** (middleware crashes on non-ASCII rep names → 3 of 5 reps cannot use any authenticated API).
- **Auth-stale `/api/auth/me`** (returns JWT role, not DB-fresh) plus a related ghost-rep variant.
- **Family of analytics under-counts** documented in `DATA_INTEGRITY_PLAN.md` is partially unfixed (3 sites still equality-filter on `pipeline_leads.status`).
- **Lark webhook hardening gaps** (encrypt-mode silent drop, no body-size limit, signature no-op without key).
- **`webhook_events` has no `svix-id` dedup** — Resend retries double-count.
- **`/api/scorer` POST has no auth** — model registry poisoning vector when combined with `promote-latest`.

---

## What the app is

**Qiji Pipeline (奇绩算力)** — Next.js 16 sales pipeline for Chinese AI researcher outreach. Daily cron scans arXiv, enriches via S2, routes to Leo / Yujie / Ethan, drafts via Gemini, sends via Resend, tracks WeChat conversion. Helper bot via Lark (HTTP webhook + WS worker).

Inventory: **161 API routes · 35 pages · 86 lib modules · 66 SQL migrations · 10 Vercel crons.**

---

## Findings (30, ranked)

### P0 — production blockers

#### 1. Middleware crashes on non-ASCII rep names
- **File:** `src/middleware.ts:57` — `reqHeaders.set("x-rep-name", session.repName)`
- **Error:** `TypeError: Cannot convert argument to a ByteString because the character at index 0 has a value of 26460 which is greater than 255.` (HTTP headers must be Latin-1; Chinese characters > 255.)
- **Affected reps in current DB (3 of 5):** 杜雨洁 (id=2 sales), 曹鸿宇泽 (id=3 sales), 王幸泽 (id=5 admin).
- **Real-user impact:** They can log in (`/api/auth/me` is on the public-prefix bypass) but every authenticated API call after that returns HTTP 500 with the dev HTML error page. 2 of 3 sales reps are silently locked out of `/pipeline`, `/emails`, everything.
- **Repro:** `curl -H 'Cookie: qiji_session=<jwt-with-chinese-name>' http://localhost:3001/api/pipeline?limit=3` → HTTP 500.
- **Fix:** `reqHeaders.set("x-rep-name", encodeURIComponent(session.repName))` — one line.

#### 2. `POST /api/scorer` has no auth gate
- **File:** `src/app/api/scorer/route.ts:52`
- Anyone reachable can insert into `scorer_runs`. Combined with `/api/scorer/promote-latest` (bearer-only, picks newest by `trained_at`), a poisoned run with future timestamp + the bearer token = live model swap.
- **Fix:** add `requireAdmin(req)`.

#### 3. `/api/inbound` fails open if `INBOUND_SECRET` unset
- **File:** `src/app/api/inbound/route.ts:25-32` — static bearer compare, not HMAC.
- If env var is missing in any env, anyone can POST and create fake `inbound_emails` rows + flip `pipeline_leads.status='replied'`.
- **Fix:** require Svix HMAC like `/api/webhook` does.

### P1 — silent correctness bugs

#### 4. Conversion analytics single-state under-count (3 sites)
- `src/app/api/metrics/route.ts:59` `.eq("status","sent")` on `pipeline_leads` → loses leads progressed to `replied`/`wechat_added`. Live: 312 vs 316 (4 lost today; grows linearly with replies).
- `src/app/api/help/opening/route.ts:56,57` — same pattern in daily opener.
- `src/app/api/pipeline/analytics/route.ts:168,192,404` — "replied" count via single-state equality.
- **Fix:** use `CONTACTED_LEAD_STATUSES` set or join through `webhook_events` per CLAUDE.md.

#### 5. `db-funnel.ts` reads `emails.status` (latest-event-wins)
- `src/lib/db-funnel.ts:114-116` — totalClicked / totalBounced read from `emails.status`. CLAUDE.md says don't do this. Click-then-complain emails silently drop from click count. Only `src/lib/diagnose-metric.ts` follows the canonical `email_history` view.

#### 6. `pipeline_leads.status='wechat_added'` is read-declared, write-orphaned
- `src/lib/status.ts:97,125` declares it in `TERMINAL_LEAD_STATUSES`/`CONTACTED_LEAD_STATUSES`. Zero writers in `src/`. Live: 0 of 1443 leads. The moment any UI tile filters by it → silent 0% conversion.

#### 7. `/api/auth/me` returns stale JWT role
- `src/app/api/auth/me/route.ts:5,21` — uses bare `verifySession(...)`, never re-reads `sales_reps.role` from DB.
- A demoted admin keeps seeing `role:"admin"` in the response for up to 30 days. UI elements gated on `me.role` show admin chrome to non-admins.
- Fuzz agent confirmed ghost-rep variant: JWT with `repId=999` returns `{authenticated:true, role:"admin"}`.
- **Fix:** call `requireSession(req)` in this route.

#### 8. `webhook_events` has no `svix-id` dedup
- `src/app/api/webhook/route.ts:201,253` — INSERT on every event with no existence check. No `UNIQUE(svix_id)` constraint. `svix-id` isn't even stored.
- Resend retries → duplicate rows. CLAUDE.md says webhook_events is "append-only and authoritative" — duplicates break that. `attributeEventToContract` (line 262-299) double-counts on retry.
- **Fix:** store `svix-id`, add unique index, `ON CONFLICT DO NOTHING`.

#### 9. `person-resolver.ts` is racey + non-atomic
- `src/lib/person-resolver.ts` — concurrent first-touch creates duplicate persons (no UNIQUE on identifier columns). Multi-row merge spans 5+ statements with no transaction.
- Confidence parameter doesn't exist; `<0.85 → person_enrichment_candidates` rule from migration 035 is honor-system-only.

#### 10. `/api/pipeline/batch-send` skips `checkBlocked`
- Single-send (`src/app/api/pipeline/send/route.ts:159`) calls `checkBlocked`; batch-send does not. A blocklisted recipient with a `ready` lead created before the block can be batch-sent.

#### 11. HF regex still buggy
- `src/lib/repo-extractor.ts:11` — `(?:models?\/|datasets?\/|spaces\/)?` group is optional, so it captures `huggingface.co/v1/production`, `papers/2402.12345`, etc. as repos. CLAUDE.md flagged this; never fixed.

#### 12. Discovery → Pipeline promotion silently drops `signals`
- `src/app/api/discovery/[id]/promote/route.ts:168-184` — discovery row's rich `signals` JSONB (top_model, downloads, star_count, twitter, languages) is NOT copied to pipeline_leads. `person_id` linkage is also missing — bypasses dedup gate.

#### 13. Promote not idempotent — double-click creates two rows
- Same file: 409 guard reads `promoted_at IS NULL` *before* the update; fast double-tap, both reads see null, both inserts succeed.

### P2 — UX & operational

#### 14. `/api/pipeline?limit=1000` takes ~27s
- Daily-driver fetch on `/pipeline`. No streaming/pagination. Page paints skeletons; user opens it dozens of times a day.

#### 15. Send button fires immediately, no confirm/preview
- `/pipeline` Send button POSTs `/api/pipeline/send` with no eligibility hint or confirmation. On error returns generic "Unable to fetch data" red banner. Dangerous and uninformative.

#### 16. Polling storm from sidebar
- `/api/inbox/unread-count` and `/api/pipeline/ready-count` fire ~2 reqs/sec on every page (>2400 in a 15-min session). No SWR/dedup, no `clearInterval` on unmount.

#### 17. Voice-template Preview shows "Preview degraded — fetch failed"
- `/settings/voice-templates` Preview modal can't reach the LLM proxy. Body literally says "production sends would either succeed or surface this same error" — admin can't validate templates before activating.

#### 18. `/api/auth/debug` is public
- `src/app/api/auth/debug/route.ts:4` — leaks `AUTH_SECRET` length (43) and JWT prefix to anyone. Reachable via the `/api/auth` middleware allowlist.

#### 19. `secure: true` cookie on `http://localhost`
- `src/app/api/auth/login/route.ts:53` and others set `Secure` unconditionally. Browsers silently drop the cookie on HTTP localhost. Browser-driven QA had to inject JWTs manually.
- **Fix:** `secure: process.env.NODE_ENV === "production"`.

#### 20. `/api/pipeline` accepts invalid limit silently
- `?limit=abc` returns 200 + empty leads. `?limit=99999` clamps to 1000 but echoes 99999 in response. Should 400 on invalid.

#### 21. `/api/help/predictions` has no idempotency
- 10 concurrent identical POSTs created 10 distinct rows. Skews accuracy snapshot.

#### 22. Cookie deletion mid-session crashes React
- Deleting `qiji_session` and clicking nav → `Runtime Error: Rendered fewer hooks than expected. ... at src/app/layout.tsx:46:15` (the `<HelpBot />` line). User sees error overlay instead of `/login` redirect.

#### 23. `/logs` reachable by any logged-in rep
- `src/app/logs/page.tsx:22` consumes the global `/api/metrics` feed. Sales reps see cross-rep recipient/subject across the team. No client-side admin gate.

#### 24. Email click-history spinner never resolves
- `/emails` detail view: `GET /api/emails/{id}/clicks` returns 200 with events, but the bottom panel sits in skeleton state forever. Pure client-side render bug.

#### 25. "Sending" emails tab skeleton ~8s with `0 total`
- `/emails` Sending tab: API returns ~50 emails but the list pane stays skeleton for 8+ seconds before populating. Receiving tab has empty state — Sending does not.

#### 26. Ready-count three-way mismatch
- `/pipeline` shows "READY 142/156", sidebar shows "156", filter says "Ready 142", banner says "123 ready to send". Three different numbers for the same concept on the same page.

#### 27. Brief search advertised "name OR email" — only name works
- `/brief` placeholder says "Enter first name, e.g. Jiahao". Searching `@tsinghua.edu.cn` returns "No matches found".

### P3 — operational hygiene

#### 28. Migration 038 is duplicated
- Both `migrations/038-bench-sim.sql` AND `migrations/038-jitr-offers.sql` exist. Only `apply-038.mjs` exists and points at bench-sim. `jitr_offers` is read by app code (was hand-applied to prod). Fresh-DB rebuild via runners is broken.

#### 29. CLAUDE.md says latest migration = 037; actual = 066
- 29 migrations of drift. Update before this misleads the next migration author.

#### 30. ~70% of recent migrations skip BACKFILL section
- `migrations/MIGRATION_TEMPLATE.md` exists; enforcement has decayed since ~migration 040. The Tier 4 backfill bug class is unguarded.

### Bonus — also worth filing

- **`/api/cron/proactive-signals` is orphaned** (file says "scheduled in vercel.json", isn't). `voice_capture_offer` chime-in is dark.
- **`template-proposals` and `congress-hypothesis` cron routes don't 503 when `CRON_SECRET` is unset** — `Bearer undefined` would pass on a misconfigured deployment.
- **Lark webhook silently drops events when Encrypt Key is enabled in console** — `src/app/api/lark/webhook/route.ts:39-41`. Admin enables encrypt → bot goes dark, monitoring still says 200.
- **`/api/auth/switch` requires no re-auth** — stolen pool cookie = 30-day persistent access to all pooled accounts, no audit log.
- **`lint:integrity` doesn't catch the `pipeline_leads.status` family** — bans only `emails.status` event values. The 5 sites in finding #4-6 wouldn't be caught.
- **Login uses `.ilike()` with user input** — `src/app/api/auth/login/route.ts:27` allows `%`/`_` wildcards.
- **Admin mutations have no audit log** — reassign-leads, rep-trust, blocklist-DELETE leave no actor trail.

---

## What I couldn't test (and why)

- Live Resend send (Send button 500'd; arguably a feature for QA safety).
- Sales-role personas via browser (middleware crash blocks all auth'd API calls).
- Real Lark message round-trip (would burn LLM + Lark API quota).
- Anything POSTing to: cron, scorer/{train,promote,promote-latest}, points/reweight, drift/mine, retrain/proposal, contracts/sweep, investor/tick, congress-hypothesis (all mutate live state).

---

## Coverage map

| Wave | Agents | Mode | Findings contributed |
|---|---|---|---|
| 1 | 8 (auth · pipeline · lark · templates · scorer · discovery · congress · admin) | Static + 401 dry-run | Findings 2, 7, 9, 10, 11, 12, 13, 18, 19, plus the bonus list |
| 2 | 8 (cron · analysis · drift · brief · helper-tools · email-send · integrity-scripts · pages-UX) | Static + 401 dry-run | Findings 4, 5, 6, 8, 23, 28, 29, 30 |
| 3 | 5 (admin-Playwright · lark-fuzz · API-fuzz · sales-Playwright · live-data-integrity) | Real QA with real JWTs | Findings 1, 14, 15, 16, 17, 20, 21, 22, 24, 25, 26, 27 |

---

## Cleanup notes

- Dev server I started on `:3001` has been killed; the original dev server on `:3000` was untouched.
- Helper mint scripts (`scripts/_mint-jwt-qa*.mjs`) deleted.
- Test JWTs in `/tmp/qa-jwt*.txt` are 7-day cookies — they'll expire on their own; safe to delete now.
- Screenshots in `/Users/xingzewang/qa-shots-admin/` and `/Users/xingzewang/qa-shots-sales/` if you want to view the UI bugs.
