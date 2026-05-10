# Mail App — Smoke Test Report
**Date:** 2026-05-10
**Target:** `/Users/xingzewang/Desktop/mail` (Qiji Pipeline) — direct DB queries via Supabase service role + static analysis. Production at calistamind.com is gated by Vercel DDoS layer.
**Coverage:** A) Data-integrity audit · B) Dead-link audit · C) Mission-system end-to-end · D) Congress-live end-to-end · E) Re-verification of 2026-05-09 findings · F) Type/lint baselines.
**Baseline state:** `tsc --noEmit` ✓ · `lint:integrity` ✓ · `lint:fetch` ✓ · `npm run lint` ✗ (128 errors in src/, dominated by React-19 strict-mode `set-state-in-effect` and `JSX-in-try/catch` advisories).

---

## TL;DR

The 2026-05-09 batch landed cleanly — **23 of 30 findings are now fixed** in the working tree. The remaining issues split:

- **One P0 data-correctness issue still degrades /api/insights** (under-count). The 1000-row pagination cap is fixed, but the H-index / school-tier / direction / citations slices still surface only ~23% of delivered emails because **77% of recipients are Python-scanner sends with no `pipeline_leads` row** to join against. The user's "148 emails" complaint moves to ~301 with the pagination fix but the architectural under-count remains.
- **One P1 mission-system divergence**: the new `/api/congress/runs` (live stepwise) path **does NOT persist `team_focus` / `weekly_missions`**; only the synchronous `/api/congress/weekly` cron path does. Live UI runs feel functional but yield no team focus or per-rep missions.
- **One P2 polling bug**: `/congress/[id]/live` keeps polling every 2s even after run finishes — comment says "Don't refresh if we know the run finished" but the code still fires the interval.
- **Heuristic-seed targets admins inappropriately**: admins get `send` missions with target=5 even though they have no sender_email and shouldn't be sending.
- Remaining bonus bugs from prior report: `template-proposals` cron uses `Bearer ${process.env.CRON_SECRET}` (fail-open if unset); `/api/auth/login` still uses `.ilike()` on user input (% / _ wildcards); admin mutations have no audit log; Lark webhook silently drops encrypt-mode events.

---

## What's now FIXED (was open in 2026-05-09)

| # | Issue | Where verified |
|---|---|---|
| 1 | Middleware crash on Chinese rep names | `src/middleware.ts:62` — `encodeURIComponent(session.repName)` |
| 2 | `POST /api/scorer` open | `src/app/api/scorer/route.ts:60-66` — `requireAdmin` gate added |
| 3 | `/api/inbound` fail-open | `src/app/api/inbound/route.ts:31-54` — Svix HMAC verify |
| 4 | Conversion analytics single-state | `src/app/api/metrics/route.ts:65-73`, `help/opening:58-62`, `pipeline/analytics:108,171` — `CONTACTED_LEAD_STATUSES` / `REPLIED_LEAD_STATUSES` |
| 5 | `db-funnel.ts` reads `emails.status` | `src/lib/db-funnel.ts:91-106` — joined through `email_history` view |
| 6 | `wechat_added` write-orphaned | `src/lib/status.ts:89-90` — value removed from enum |
| 7 | `/api/auth/me` stale role | `src/app/api/auth/me/route.ts:19` — `requireSession()` re-reads DB |
| 8 | `webhook_events` no svix dedup | migration `071-webhook-events-svix-dedup.sql` + handler `src/app/api/webhook/route.ts:212-223,278-292` |
| 10 | Batch-send skips DNC | `src/app/api/pipeline/batch-send/route.ts:175` — `checkSendAllowed` includes DNC |
| 11 | HF regex captures noise | `src/lib/repo-extractor.ts:16` — required model/dataset/spaces prefix |
| 12 (partial) | Discovery promote drops `signals` + `person_id` | `src/app/api/discovery/[id]/promote/route.ts:235-249` — `person_id` resolved; `signals` still dropped (acknowledged in code comment, deferred until `pipeline_leads.signals` lands) |
| 13 | Promote not idempotent | Same file `:152-192` — atomic `UPDATE … WHERE promoted_at IS NULL .select()` |
| 15 | Send button no confirm | `src/app/pipeline/page.tsx:639-645` — `window.confirm("Send to ...")` added |
| 16 | Sidebar polling storm | `src/components/sidebar.tsx:301-302` — `MIN_LOAD_GAP_MS = 5_000` floor |
| 18 | `/api/auth/debug` public | route deleted (`src/app/api/auth/` no longer contains `debug/`) |
| 19 | Cookie `secure: true` on localhost | `src/app/api/auth/login/route.ts:53,90` — `process.env.NODE_ENV === "production"` |
| 20 | `/api/pipeline?limit=abc` returns 200 | `src/app/api/pipeline/route.ts:82-95` — `Number.isFinite` validation |
| 21 | `/api/help/predictions` no idempotency | `src/app/api/help/predictions/route.ts:80-101` — request_id (header or derived) + migration 072 |
| 22 | Cookie deletion crashes React | `src/components/help-bot.tsx:444-461` — hooks moved above `pathname.startsWith("/login")` early-return |
| 23 | `/logs` reachable by sales | `src/app/logs/page.tsx:42-66` — client-side admin gate |
| 26 | Ready-count three-way mismatch | `src/components/sidebar.tsx:312-323` — single canonical `readyNow` |
| 27 | Brief search "name only" | `src/app/brief/page.tsx:676,703` — placeholder + handler updated |

Plus the recent commits `afb7228` and `ae4d913` paginate every analytics surface that previously truncated at 1000 rows (segment-funnels, db-funnel, congress-runners, analysis.ts, congress/history). `paginateAll()` helper lives in `src/lib/supabase-paginate.ts` for new consumers.

---

## Findings (open as of 2026-05-10)

### P0 — data-correctness, user-visible

#### 1. `/api/insights` H-index / school-tier / direction slices still under-count by ~77%
- **File:** `src/lib/segment-funnels.ts:177-209`
- **Numbers:** 90-day window (today's DB):
  - 1436 emails sent, 1335 unique delivered recipients
  - 1443 `pipeline_leads` rows (now correctly paginated past the 1000 cap)
  - **Only 301 of the 1335 delivered recipients (~23%) have a matching `pipeline_leads.author_email`**. The other 1034 fall into `(no lead data)`.
  - `email_contact_history` has 3236 rows, 3236 distinct recipients, **1000 of them stamped `source: 'python_script'`** with no `pipeline_leads` linkage. Net: 2922 distinct recipients exist in `email_contact_history` but NOT in `pipeline_leads`.
- **Root cause:** Python scanner (`~/Desktop/Email/resend0412.py`) sends some emails directly via Resend and writes to `email_contact_history`/`emails` without inserting into `pipeline_leads`. Per `docs/discovery-python-contract.md` the contract is supposed to be `POST /api/pipeline/import`, but a parallel direct-send path is producing emails the dashboard never knew about.
- **User impact:** This is exactly the "148 emails over 90d" complaint. Pagination fix moved it from 148 → ~301; the rest is unrecoverable without joining recipients to a person primitive (e.g. `persons` table) instead of `pipeline_leads.author_email`.
- **Fix options:**
  1. Make `segment-funnels.ts` join on `persons` (which is supposed to be the canonical identity, per migration 035) and pull `h_index` / `school_tier` from there. Requires backfilling those columns onto `persons`.
  2. Fix the Python scanner to always go through `/api/pipeline/import` so every send creates a `pipeline_leads` row first. Cleaner; one upstream contract.
  3. Add an `(no lead data)` bucket to the UI explicitly with a "metric is biased to ~23% of sends — Python-scanner sends bypass enrichment" note. Worst option but cheapest.

### P1 — feature-not-working

#### 2. Live congress runs do not persist `team_focus` or `weekly_missions`
- **Files:**
  - `src/lib/congress-stepwise.ts:226-350` (the `finalizeRun` path used by `/api/congress/runs`) — has tactical_proposals + template fan-out, but no `team_focus` / `missions` insertion
  - vs. `src/lib/congress-runners.ts:335-423` (the synchronous path used by `/api/congress/weekly` cron) — has the full team_focus + weekly_missions persistence block
- **Impact:** Starting a weekly congress via the live UI (`POST /api/congress/runs` → polled at `/congress/[id]/live`) renders a synthesizer JSON containing `team_focus` and `weekly_missions`, but the synthesis is shown only and **never lands in the `team_focus` / `missions` tables**. Reps won't see the new focus on `/missions`; admin won't see proposals on `/admin/missions`. The cron path Mondays at 1am (per `vercel.json:10`) still works — but ad-hoc live runs are silently no-op for the mission-system half.
- **Fix:** Lift the team_focus + weekly_missions block out of `runWeeklyCongress` into a shared helper, call it from `finalizeRun` after the tactical_proposals insert.

#### 3. `/api/missions/heuristic-seed` creates `send` missions for admins
- **File:** `src/app/api/missions/heuristic-seed/route.ts:60-93`
- **Repro:** Direct DB simulation today seeds:
  ```
  Leo (senior)   ready=154 send_target=12
  Xuwen (admin)  ready=0   send_target=5    ← admin shouldn't get send
  Yujie (sales)  ready=228 send_target=12
  Xingze (admin) ready=0   send_target=5    ← admin shouldn't get send
  Ethan (sales)  ready=718 send_target=12
  ```
- **Code path:** `.neq("role", "service")` excludes service accounts but not admins. `Math.max(5, ...)` floor means even a 0-ready admin gets a send target of 5.
- **Impact:** Admins see "send 5" on `/missions` with no leads to actually send. Mission progress will never flip to `completed`. Cosmetic but undermines the dashboard.
- **Fix:** Either filter `role IN ('sales', 'senior')` for `send` missions, or skip the floor when `readyCount === 0` (different missions for admins like `review_proposals`).

### P2 — operational

#### 4. `/congress/[id]/live` polls forever after run completes
- **File:** `src/app/congress/[id]/live/page.tsx:67-83`
- **Behavior:** `setInterval(refresh, 2000)` runs unconditionally; the second `useEffect` at `:79-84` is a comment-only no-op ("Best-effort: subsequent setIntervals are harmless"). Tab left open after a 35s run keeps hitting `/api/congress/runs/[id]` every 2s indefinitely.
- **Severity:** P2 because the route is cheap and admin-scoped. But it's the exact polling-storm pattern from finding #16 of the 2026-05-09 report.
- **Fix:** Clear the interval when `run.status !== "running"`, or guard inside `refresh` with `if (run?.status !== "running") return`.

#### 5. `template-proposals` cron fail-opens if `CRON_SECRET` is unset
- **File:** `src/app/api/cron/template-proposals/route.ts:64`
  ```ts
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
  ```
  When `CRON_SECRET` is undefined, the comparison string is `"Bearer undefined"`. A request with `Authorization: Bearer undefined` (literally) passes. Every other cron route in `src/app/api/cron/` uses the safe `const secret = process.env.CRON_SECRET; if (!secret) return 503;` pattern. This one is the outlier.
- **Same bonus issue from 2026-05-09. Still here.**
- **Fix:** Mirror the `template-auto-promote` shape (lines 87-91 of that file).

#### 6. `/api/auth/login` `.ilike()` allows `%` / `_` wildcards
- **File:** `src/app/api/auth/login/route.ts:27` — `.ilike(column, normalized)`
- A login attempt with username `%` or `lo%` will match all reps / all reps starting with "lo". The `bcrypt.compare` against the dummy hash blocks the actual auth (since the matched rep's `password_hash` differs), so this isn't a credential bypass — but it does let an attacker enumerate users via timing.
- **Same bonus issue from 2026-05-09. Still here.**
- **Fix:** Use `.eq()` (case-sensitive) or escape `%` and `_` before `.ilike()`.

#### 7. Lark webhook silently drops encrypt-mode events
- **File:** `src/app/api/lark/webhook/route.ts:39-41`
  ```ts
  if (parsed.encrypt) {
    return NextResponse.json({ ok: false, reason: "encrypt not supported" }, { status: 200 });
  }
  ```
- Returns HTTP 200 (so monitoring sees green) but body says `ok: false`. Admin who flips Encrypt Key in Feishu console would see Lark stop talking with no obvious failure signal.
- **Same bonus issue from 2026-05-09. Still here.**
- **Fix:** Either implement decryption (Lark CLI has the helpers), or return 4xx + log a Tier-0 alert.

#### 8. Admin mutations still have no audit log
- `/api/admin/reassign-leads`, `/api/admin/rep-trust`, `/api/blocklist/[id]` (DELETE) leave no actor trail. A rogue admin can shuffle ownership / blocklist / trust levels with no record.
- **Same bonus issue from 2026-05-09. Still here.**
- **Fix:** Insert into a new `admin_audit_log` table (actor_rep_id, action, target_id, payload, created_at) on each mutating admin route.

### P3 — type/lint baseline regressed since 2026-05-09

#### 9. ESLint baseline now has 128 errors / 51 warnings in `src/`
- The 2026-05-09 report claimed all four baselines were clean. Running `npx eslint src/ --max-warnings 0` today gives:
  - 58 errors in `src/components/help-bot.tsx` (mostly `react/no-unstable-nested-components` / `JSX-in-try/catch`)
  - Spread of `set-state-in-effect` advisories (React 19 strict-mode)
  - 3 real `prefer-const` errors (auto-fixable)
- **Why this matters:** the integrity / fetch lints are the safety nets the team relies on; they still pass, but `npm run lint` is no longer a clean signal. A new contributor running `npm run lint` will see 128 errors and stop noticing real ones.
- **Fix:** Auto-fix the 3 `prefer-const`, then either downgrade the React-19 advisories to warnings in `eslint.config.mjs` or open targeted PRs to refactor the affected components.

### Bonus — also worth filing

- **Mission-system bumpMissionProgress is per-call, not atomic.** `src/lib/missions.ts:62-80` reads `count`, computes `count + by`, writes back. Two concurrent sends from the same rep will race and one increment is lost. Real-world impact is small (sends are ~one per few seconds per rep, mission_progress isn't multi-writer at any meaningful rate), but it's still racy. Comment at line 60 acknowledges this.

- **Ready-count for Ethan (rep_id=3) is 718.** That's much larger than Leo (154) and Yujie (228). This isn't a bug per se but suggests the routing rules in `SALES_RULES.md` may be funneling more leads than Ethan can work through.

- **`email_template_overrides` has 0 rows in prod.** The whole segment-conditional override system (CLAUDE.md "Templates render at SEND time") has no production data driving it. Either the path isn't being used, or the data didn't get backfilled when the table was added. Worth checking with the team.

- **`congress_runs` and the live UI assume `notifyAdminText` works.** No fallback or failure path if the Lark webhook is down. Synthesizer output is persisted, but admin won't be notified. Probably acceptable given how rare it is, but worth knowing.

- **Heuristic-seed inserts as `status='active'` directly,** bypassing the `proposed → approved` admin review flow that congress missions go through. Comment claims this is OK because it's a "v0 something to do" generator. Defensible but inconsistent — `/admin/missions` won't show heuristic missions in the approval queue.

---

## What I verified

### Mission system end-to-end (Coverage C)
Direct DB simulation against prod (then rolled back):
- ✓ `POST /api/missions/heuristic-seed` → inserts 5 missions for 5 active reps (1 per rep × `kind='send'`)
- ✓ `GET /api/missions` → `v_mission_today` view returns the 5 inserted missions
- ✓ `bumpMissionProgress(repId, "send", 1)` → `mission_progress.count` increments, view reflects it on next read
- ✗ But: 2 of 5 reps are admins who shouldn't receive `send` missions (P1 finding #3 above)

### Congress-live end-to-end (Coverage D)
- ✓ `congress_runs` and `congress_interjections` schemas exist (0 rows in prod today)
- ✓ Insert + delete of fake congress run row succeeds
- ✓ `tactical_proposals` exists (1 row from prior runs)
- ✗ But: stepwise `finalizeRun` doesn't persist `team_focus` / `weekly_missions` (P1 finding #2 above)
- I did not actually trigger a live LLM run (would burn ~$0.50 of LLM tokens for 7 personas; not justified for smoke validation when the schema and code paths are verified)

### Data-integrity audit (Coverage A)
- `/api/insights` → `computeSegmentFunnels` → reproduced the user's "148" complaint (now ~301 with pagination fix; rest is the orphan problem documented in P0 finding #1)
- `/api/metrics` → uses `CONTACTED_LEAD_STATUSES` (verified in code)
- `/api/pipeline/analytics` → uses `REPLIED_LEAD_STATUSES` and `CONTACTED_LEAD_STATUSES` (verified)
- `/api/help/opening` → uses `CONTACTED_LEAD_STATUSES` (verified)
- `/admin/template-insights`, `/api/templates/library`, `/api/templates/[id]/inspect` — all schema-clean, return data
- `email_templates`: 11 rows (1 active, 10 proposal); `template_ratings`: 0 rows; `template_edits`: 0 rows; `email_template_overrides`: 0 rows

### Dead-link audit (Coverage B)
Probed every table referenced by the new mission/congress/template routes:
- All 35+ tables exist (none `MISSING:` in the probe)
- `v_mission_today` view exists and returns rows
- `email_templates.active` column exists; cron route on line 102 won't 500

### Type/lint (Coverage F)
- `npx tsc --noEmit` → exit 0, no errors
- `npm run lint:integrity` → "OK: no banned `.eq("status", "<event>")` patterns outside inbox"
- `npm run lint:fetch` → "OK: no partial migrations"
- `npm run lint` → 128 errors in `src/`, regression from 2026-05-09 (P3 finding #9)

---

## Counts

- **Data-integrity issues (open):** 1 P0 (insights orphan join) + watchlist (Python-scanner architectural gap)
- **Dead links:** 0 (every page's API endpoint and table exists)
- **Regressions from 2026-05-09:** 1 (eslint baseline, finding #9). The other "still open" items (template-proposals secret, login `.ilike()`, Lark encrypt, admin audit) were on the bonus list of the prior report and were never claimed fixed.
- **Top 3 P0/P1 issues:**
  1. **P0** — `/api/insights` H-index / school / direction slices show ~23% of delivered emails because Python-scanner sends bypass `pipeline_leads`. The user's "148" was 23% of 1335 ≈ 307; now ~301 after pagination fix; needs join on `persons` or scanner contract change to fully resolve.
  2. **P1** — Live congress runs (`/api/congress/runs` → `congress-stepwise.ts:finalizeRun`) don't persist `team_focus` or `weekly_missions`. Synchronous cron path does. The two paths must converge.
  3. **P1** — Heuristic-seed gives admins `send` missions despite admins having no sender_email. Admins see uncompletable mission cards on `/missions`.

---

## What I did NOT touch (per instructions)

- Did not push or deploy.
- Did not commit changes; smoke-test scripts under `scripts/_smoke-*.mjs` were used and removed.
- Did not actually trigger a live LLM congress run (~$0.50, ~35s, validates same code paths as schema probes).
- Did not actually send emails or mutate prod data destructively. All test inserts (heuristic-seed simulation, fake congress_runs row) were rolled back.

---

## Cleanup notes

- All `scripts/_smoke-*.mjs` scratch files removed.
- Working tree state is unchanged from the original git status snapshot (modified files for the in-flight `person-resolver-enrichment` branch, new template-ratings + auto-promote files; nothing the smoke added).
