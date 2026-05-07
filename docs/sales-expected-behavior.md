# Sales user expected behavior — the invariant sheet

Every smoke-test agent checks the actual code against THIS spec. If the
code doesn't match, it's a defect.

Assume user = Yujie, `role='sales'`, `repId=2`, `sender_email='yujie@compute.miracleplus.com'`, `active=true`.

## 1. Authentication

- [ ] Unauthenticated request to ANY sales-facing API returns 401, not partial data.
- [ ] Session cookie missing/expired → UI redirects to login or 401.
- [ ] Login with valid credentials sets `qiji_session` cookie with repId/role/email/name in JWT.
- [ ] `/api/auth/me` returns `{authenticated:true, repId:2, role:"sales"}` for Yujie.
- [ ] Logout clears the active cookie and doesn't silently promote a stale admin pool token.

## 2. Pipeline data visibility

- [ ] `GET /api/pipeline` returns ONLY rows with `assigned_rep_id=2`. No others.
- [ ] `GET /api/pipeline/ready-count` returns the count of her ready leads, matching the list page.
- [ ] `GET /api/pipeline/analytics` returns metrics computed ONLY from her rows.
- [ ] Channel counts (arXiv/HF/GH/PH) and status counts (All/Drafting/Ripening/Ready/Sent/Replied/Skipped) all sum over her rows only.
- [ ] "All 28" and "All status X" numbers come from the same scoped source; they should be coherent.
- [ ] Sidebar badge matches page count.

## 3. Email + Inbox visibility

- [ ] `GET /api/emails` returns ONLY emails where `from` ilike `%yujie@compute.miracleplus.com%` (or `%chenyu@compute.miracleplus.com%` for historical rows sent before the rename).
- [ ] `GET /api/emails/[id]` 404s if the row's `from` doesn't match her sender.
- [ ] `GET /api/inbound` returns ONLY inbounds whose `thread_id` matches a thread she originated.
- [ ] `GET /api/inbox/unread-count` same scope.
- [ ] `PATCH /api/inbound/[id]` (mark read) 404s if the thread isn't hers.

## 4. Send flow

- [ ] `POST /api/pipeline/send` 401s without session.
- [ ] 404s on a lead not assigned to her (cannot send others' leads).
- [ ] 400 if `author_email` is null/empty on the lead.
- [ ] 400 if `draft_subject` or `draft_html` is null/empty AND no editedSubject/editedHtml provided.
- [ ] For a <7d-old lead WITHOUT override=true, returns 422 `age_gate` with the "勾上 Override 7-day rule" message.
- [ ] For a <7d-old lead WITH override=true, passes the age gate.
- [ ] If published_at is <7d AND override=true, ALSO passes the `too_new` guard.
- [ ] Daily override cap: after 200 overrides today (Beijing day), next override send 429s with `daily_override_limit`.
- [ ] `blocked` recipients return 409 with block reason.
- [ ] Cross-rep `already_contacted` returns 409.
- [ ] If Resend THROWS (network), lead returns to `status='ready'` (not stuck at `sending`).
- [ ] If Resend returns result.error, same rollback.
- [ ] Success: `status='sent'`, `sent_at` set, `thread_id` set, `override_used=true` if overridden, row written to `emails` table with rep's sender in `from`.
- [ ] Sender identity = lead's assigned rep's sender_email; fallback to acting rep; fallback to env. Never `undefined <undefined>`.

## 5. Batch send

- [ ] 401 without session.
- [ ] Each iteration skips (not aborts) on per-lead errors; remaining leads continue.
- [ ] Silently skips leads not owned by the caller (non-priv).
- [ ] Skips null-email / null-draft leads; surfaces in `blocks` breakdown.
- [ ] Override budget: once exhausted mid-batch, remaining overrides get `daily_override_limit` reason; non-override sends keep going.
- [ ] Returns `{sent, skipped, errors, blocks, overridesUsed}` with non-empty blocks breakdown when things are skipped.
- [ ] Auto-chunks when > 200 ids client-side.

## 6. Review pane

- [ ] Deeplink `?lead=X` in Review mode lands the cursor on lead X (not idx=0).
- [ ] Paper age shown as `publishedAt` (not `createdAt`) where available.
- [ ] Override checkbox only visible when `gated=true`.
- [ ] Shows "N/200 used today" suffix when quota endpoint returns `hasQuota:true`.
- [ ] Single-author leads show "Single author — no switch needed" hint.
- [ ] Cmd+Enter does NOT fire send when EditReason modal is open.
- [ ] Skipping a lead with in-flight edits persists those edits via PATCH.
- [ ] After successful send, cursor advances via parent refetch (doesn't double-advance).

## 7. Bulk pane

- [ ] Selection persists across refetches (initialized once on mount).
- [ ] Age label shows paper age (publishedAt).
- [ ] Select-all three-state logic: none → select non-gated; mixed → select all + override all gated; all → clear.
- [ ] Handling of 200-lead cap via client-side chunking with progress bar.
- [ ] Toast at end of multi-batch send shows `sent N, skipped M — code: N, code: N` breakdown.

## 8. Role-gated UI

- [ ] "Re-assign" button only visible to admin.
- [ ] "Settings" button only visible to admin.
- [ ] Per-rep pills only visible to admin.
- [ ] Hard flag (`severity=hard`) 403s for sales; soft flag works.
- [ ] `/bench`, `/drift`, `/scorer`, `/settings` pages bounce sales back to `/`.
- [ ] `DELETE /api/pipeline/[id]` 403s for sales.

## 9. Brief / WeChat follow-up

- [ ] `GET /api/brief` requires session; cross-rep search OK (by design).
- [ ] `POST /api/brief/wechat` requires session.
- [ ] `POST /api/brief/ask` requires session.
- [ ] `GET /api/brief/summary` requires session.

## 10. Help bots

- [ ] `/api/help/ask` (Sales Helper) — requires session; grounds in Qiji facts + sales guide; refuses accelerator questions.
- [ ] `/api/help/paper` (Paper Tutor) — requires session; scoped to current review lead; refuses sales-script questions; no ownership check (any rep can ask about any paper, non-sensitive).
- [ ] HelpBot mode toggle clears chat when switching between Paper Tutor / Sales Helper.

## 11. Correctness under partial failures

- [ ] DB read error in `countOverridesTodayByRep` fails CLOSED (returns cap to block).
- [ ] DB read error in `lastContactedAt` fails CLOSED (returns now-timestamp).
- [ ] Blocklist filter rejects emails/domains with PostgREST metacharacters.
- [ ] Arxiv id regex is anchored so `2401.12345-v2` doesn't bypass paper dedup.
