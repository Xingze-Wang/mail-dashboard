# Miracle Mail — App Overview

This is the end-to-end explainer for what this app is, how it's structured,
and how data moves through it. Written for a new engineer or operator who
needs to understand the whole thing in one sitting.

---

## 1. What the app does (one paragraph)

It's a lead-generation + outreach tool for **Qiji Compute**, the GPU grant
program run by 奇绩创坛. Every day it scans arXiv (and other sources) for
AI researchers who might need compute, scores them, drafts a personalised
Chinese email in a sales rep's voice, and presents them to the sales team
for one-click review-and-send. Sales can flag bad leads, edit drafts, and
track replies. All of that feedback feeds a scorer-training loop so the
system improves over time.

Not to be confused with the 奇绩创业营 (Accelerator) — this program is
specifically about giving researchers free compute in exchange for early
relationships with promising labs.

---

## 2. The physical stack

| Layer | Thing |
|------:|-------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, inline CSS + Tailwind utilities, `recharts` |
| Auth | JWT cookies (`jose`), 30-day sessions, 3 roles: `sales` / `senior` / `admin` |
| DB | Supabase Postgres (primary); a small sidecar on libSQL for some persistence |
| Email | Resend (transactional), Resend Inbound for replies |
| LLM | Gemini 3 Flash/Pro for most writes, Claude Opus 4.7 for drift-mining, all through `src/lib/llm-proxy.ts` |
| External | Semantic Scholar (h-index/citation enrichment), Tavily (web grounding) |
| Hosting | Vercel (serverless functions for API routes, cron via `vercel.json`) |
| Scorer training | GitHub Actions workflow kicked off by `/api/scorer/train`, script in `scripts/train_scorer.py` |

The codebase is a single Next.js app. There's no separate backend service
— every API route is a Vercel function in `src/app/api/…/route.ts`.

---

## 3. Mental model: six stages of a lead

Every lead passes through the same pipeline, left-to-right:

```
 ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
 │ Discover │→ │  Score   │→ │  Draft   │→ │  Review  │→ │   Send   │→ │ Followup │
 └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
   scanner      gemini +      template +     sales      7-day gate     inbound
   /discovery   s2 rollup     ack-mining     decides    contact-guard  + replies
```

Corresponding stages in the DB (`pipeline_leads.status`):

`new` → `drafting` → `ripening` → `ready` → `sending` → `sent` → `replied` / `skipped`

- **ripening**: paper is in the 7-day cool-down after ingest (`policy.ts`);
  cannot be sent without an override.
- **sending**: claimed by the send route, awaiting Resend ack (brief
  state, only exists while an HTTP request is in flight).
- **skipped**: sales deliberately rejected the lead, or it was auto-
  skipped due to a hard flag.

---

## 4. Where everything lives (code map)

### 4.1 Pages (`src/app/…`)

| Route | What it is |
|-------|-----------|
| `/` | Overview dashboard — funnel, volumes, sales conversion |
| `/pipeline` | **Main workspace.** Leads + Channels + Sales tabs. Review/Bulk/Browse modes. |
| `/pipeline/[...]` → `ReviewPane.tsx` | Focused one-lead-at-a-time review with editable subject/body |
| `/brief/[id]` | Per-lead brief page (read-heavy, standalone URL shareable) |
| `/inbox` | Inbound replies threaded against the sent email |
| `/emails` | Every sent email (audit log) |
| `/drift` | Prompt-drift mining + Judge-vs-Human + Human Signals |
| `/scorer` | Scorer training workbench (F1/AUC history, feature match, promote new model) |
| `/bench` | LLM bench harness (side-by-side prompt comparisons) |
| `/templates` | Email template experiments |
| `/settings` | Rep management, assignment config, blocklist |
| `/logs` | Raw event / error feed |

The **app shell** lives in `src/app/layout.tsx` and ships the floating
HelpBot (`src/components/help-bot.tsx`) on every page except `/login`.

### 4.2 Shared libraries (`src/lib/…`)

| File | Responsibility |
|------|----------------|
| `scanner.ts` | Fetches arXiv XML, parses entries, extracts emails, matches Chinese authors, scores compute needs, writes leads |
| `scanner-config.ts` | Constants: 90+ Chinese surnames, school tiers, direction list, `APPLY_URL_CTA` |
| `assignment.ts` | `classifyLead()` (strong/normal) + `assignRep()` (round-robin + overrides) |
| `email-generator.ts` | Builds the Chinese outreach email HTML from the lead + rep + paper context |
| `ack-mining.ts` | Pulls acknowledgements out of PDFs to detect prior GPU funding (disqualifier) |
| `contact-guard.ts` | **The firewall**: 365-day dedup across `emails` / `email_contact_history` / `persons` |
| `policy.ts` | `MIN_AGE_DAYS = 7`, `isAgeGated()`, `leadAgeDays()` |
| `override-quota.ts` | **Per-rep daily cap of 200** on 7-day-rule overrides, Beijing-day boundary |
| `semantic-scholar.ts` | Author lookup → h-index, citation count, paper count |
| `industry-orgs.ts` | Detects OpenAI/Anthropic/Anyscale/etc affiliations from email domain or paper |
| `blocklist.ts` | Recipients sales has hard-flagged (never email again) |
| `llm-proxy.ts` | Thin wrapper: `{ model, system, user, json?, timeoutMs }` → text. Handles Gemini, Opus, and Haiku |
| `gemini-scorer.ts` | Gemini-based lead scoring (fallback when the trained classifier isn't loaded) |
| `bench-judge.ts` | LLM-as-judge that rates sent emails 0-10 on 4 axes |
| `qiji-facts.ts` + `sales-guide-corpus.ts` | Ground truth corpora for the HelpBot (one for program facts, one for UI workflow) |
| `auth.ts` + `auth-helpers.ts` | JWT + `requireSession` / `requireAdmin` / `requireSenior` gates |

### 4.3 API routes (`src/app/api/…`)

Roughly grouped:

- **Pipeline:** `pipeline/route.ts` (GET list, POST scan), `pipeline/[id]` (PATCH edit/skip), `pipeline/send`, `pipeline/batch-send`, `pipeline/scan`, `pipeline/record` (mark WeChat replied), `pipeline/analytics`
- **Lead actions:** `lead/correct` (flag), `lead/switch-author` (retarget to co-author)
- **Scorer:** `scorer/train` (GH dispatch), `scorer/training-data`, `scorer/promote-latest`, `scorer/backfill`, `scorer/live`, `scorer/match`, `scorer/conversion`, `scorer/email-quality`, `scorer/rubric`
- **Drift:** `drift/mine`, `drift/patterns`, `drift/disagreement`, `drift/rejudge`, `drift/human-signals`
- **Help:** `help/ask` (sales copilot), `help/paper` (paper tutor)
- **Email lifecycle:** `inbound` (Resend webhook), `reply`, `emails/*`
- **Ops:** `cron` (scheduled scans), `migrate/*`, `debug/*`, `sync`, `setup`
- **Auth:** `auth/login`, `auth/logout`, `auth/me`

---

## 5. Data flow — the main loop

### 5.1 Discovery → Lead

1. **Cron** (via `vercel.json` → `/api/cron`) fires `scanArxiv()` on some
   cadence (typically hourly).
2. `scanner.ts`:
   - Fetches arXiv Atom feed for AI/ML categories.
   - Parses entries → for each paper, runs a regex to extract author
     emails from PDF text.
   - Filters: Chinese surname match (~90 common surnames), school tier
     lookup (`SCHOOL_DATA`), compute-signal classifier.
   - Writes raw matches to the `papers` + `paper_authors` tables
     (archival).
3. For matches that cross the "worth contacting" threshold, calls
   `generateDraft()` and inserts a row into `pipeline_leads` with
   `status='ready'` (or `'new'` if drafting failed).
4. `assignment.ts` assigns the lead to a rep based on tier + direction +
   geography (overseas → Ethan, domestic → Yujie, strong → Leo).
5. Parallel path: non-arXiv sources (Hugging Face, Product Hunt, GitHub,
   Jike, Xiaohongshu, V2EX, Weibo) write into `discovery_leads` via the
   Python scrapers under `vc-lead-scout` skill; sales promotes them into
   the main pipeline via `/api/discovery/[id]/promote`.

### 5.2 Review → Send

Sales opens `/pipeline`, switches to **Review mode**, and sees leads one at
a time (filtered to `status='ready'`). For each lead:

- **Left pane**: paper context — title, full author list with current
  recipient highlighted, school, compute-level tag, h-index, abstract,
  embedded ar5iv iframe for the full paper.
- **Right pane**: editable subject + body. Body is plain-text in the
  textarea (`htmlToPlainText`); on send it either goes through untouched
  (if `!isEdited`) or gets re-wrapped with `plainToHtml()` which
  preserves signature color and re-links "申请" to `APPLY_URL_CTA`.
- **Actions**:
  - **Send** → `POST /api/pipeline/send`
  - **Skip** → `PATCH /api/pipeline/[id] { status: "skipped" }`, preserves
    in-flight edits so nothing is lost
  - **Flag** (🚩) → `POST /api/lead/correct` with one of 6 categories
  - **Switch recipient** → `POST /api/lead/switch-author` (e.g. retarget
    from PI to first-author PhD)

Server-side the send path enforces in this order:
1. 7-day age gate (created_at anchored) — override is opt-in
2. **Per-rep daily override cap of 200** (`override-quota.ts`), Beijing-day
3. Hard blocklist check (`blocklist.ts`)
4. Contact-guard: 365-day dedup across `emails` / `persons` / `email_contact_history`
5. Optimistic claim `ready → sending` (prevents double-send race)
6. Rep lookup → sender identity
7. Resend API call
8. On success: `status='sent'`, `sent_at`, `thread_id`, `draft_edit_distance`, `override_used`, `edit_reasons`, `edit_note`

If Resend fails, status is rolled back to `ready` so sales can retry.

### 5.3 Inbound replies

1. Resend webhook fires `/api/inbound` when an author replies.
2. We match by `thread_id` (stamped into outbound headers on send).
3. Reply gets written to `emails` with `status='reply'` and the lead's
   `status` is flipped to `replied`.
4. WeChat-conversion tracking: sales marks `record` on the lead once they
   move the conversation off email.

---

## 6. Scoring + drift + training — the feedback loop

This is the part that actually distinguishes the app from "cold-email
blaster." Three independent feedback streams merge into a single
retrainable classifier.

```
  ┌────────────────┐          ┌─────────────────┐
  │  Signal A      │          │  Signal B       │
  │  WeChat        │          │  Bench judge    │
  │  conversions   │          │  LLM ratings    │
  └──────┬─────────┘          └────────┬────────┘
         │                             │
         ├──────┐                      │
         │      │                      │
  ┌──────▼──────▼──────────────────────▼──────┐
  │        training-data aggregator           │
  │  (/api/scorer/training-data)              │
  └──────┬────────────────────────────────────┘
         │
  ┌──────▼──────┐          ┌──────────────────┐
  │ GH Actions  │──────────│  scorer_runs     │
  │ train.yml   │          │  F1 / AUC trend  │
  └──────┬──────┘          └──────────────────┘
         │
  ┌──────▼──────┐
  │ Promote     │── replaces live classifier
  └─────────────┘

  ┌────────────────┐
  │  Signal C      │          ┌─────────────────┐
  │  Human signals │──────────│  drift miner    │
  │  (flags +      │          │  Claude Opus    │
  │  edit reasons) │          │  patterns       │
  └────────────────┘          └────────┬────────┘
                                       │
                              ┌────────▼────────┐
                              │ prompt_drift_   │
                              │ patterns        │
                              │ (admin review)  │
                              └─────────────────┘
```

### 6.1 Scorer (Signal A + B → classifier)

- **Feature extraction**: `gemini-scorer.ts` + `scripts/train_scorer.py`
  build features from abstract, title, citations, h-index, direction tags.
- **Labels**: combination of WeChat-conversion (hard positive), inbound
  reply (softer positive), skip/flag (negative).
- **Training**: `/api/scorer/train` fires a `repository_dispatch` event
  → `.github/workflows/train-scorer.yml` → `scripts/train_scorer.py`.
  Script uploads F1/AUC/ROC to `scorer_runs`.
- **Promotion**: admin reviews metrics on `/scorer` page; if good,
  clicks Promote → new model becomes live for next scan cycle.
- **Fallback**: if no trained classifier is loaded, `gemini-scorer.ts`
  rates leads via Gemini directly (slower, more expensive).

### 6.2 Drift miner (Signal C → prompt patches)

- **Input**: `pipeline_leads` where sales edited the draft materially
  (`draft_edit_distance > 0`) AND provided `edit_reasons` or `edit_note`.
- **Miner**: `/api/drift/mine` → Claude Opus 4.7 reads sample pairs,
  returns patterns like `{ category, ai_phrase, sales_phrase,
  occurrence_count, prompt_patch }`.
- **Review**: patterns land in `prompt_drift_patterns` with
  `status='pending'`; admin reviews on `/drift` and accepts/ignores.
- **Judge vs Human**: separate tab that buckets sent leads into 4
  quadrants (judge loved + sales edited heavily → judge rubric needs
  work; judge hated + sales kept → judge is too harsh; etc).
- **Human Signals**: raw `lead_corrections` + `edit_note` feed, honest
  empty-state when sample too thin (<10 rows).

### 6.3 Judge (closes the loop)

- `bench-judge.ts` rates sent emails on 4 axes (clarity, personalisation,
  persuasion, professionalism).
- Results stored in `pipeline_leads.judge_avg` + `judge_verdicts`.
- Feeds both training labels (signal B) and the drift "Judge vs Human"
  tab.

---

## 7. Key invariants (things you should not accidentally break)

1. **The 7-day gate is anchored on `created_at`, not `published_at`.**
   Papers older than 7 days can still be ripening if we only just
   ingested them. This is intentional — the gate is about *our* funnel
   age, not paper age.
2. **Contact-guard reads three tables in parallel.** Any hit blocks. If
   you're debugging a "won't send" case, check all three.
3. **Send is optimistic-lock via `status='ready' → 'sending'`.** Only the
   request that flipped the status actually sends; others get 409.
4. **Drafts in DB are canonical HTML** (with `<a href>` + inline styles).
   The plain-text round-trip in `ReviewPane` is lossy; unedited sends
   now skip that round-trip and ship the DB HTML verbatim.
5. **`override_used` is stored per row, not in a counter table.** The
   daily cap is enforced by `COUNT(*) WHERE override_used AND sent_at >=
   beijing_today_utc`. No separate counter to keep in sync.
6. **Roles cascade.** `admin ⊃ senior ⊃ sales`. Hard-flag + blocklist
   edit + prompt edit require senior+. Admin can do everything.
7. **Cross-rep visibility is intentional.** Any rep can view and flag any
   lead, even if it's not assigned to them. Assignment is for defaults,
   not enforcement.

---

## 8. Where a new engineer should start reading

If you have 30 minutes:

1. `SALES_RULES.md` — binding spec for strong/normal + assignment
2. `src/lib/scanner.ts` — see how a lead is born
3. `src/lib/email-generator.ts` — see how a draft is written
4. `src/app/api/pipeline/send/route.ts` — see every guard a send passes
5. `src/app/pipeline/ReviewPane.tsx` — see the sales UX

If you have 2 hours, add:

6. `src/lib/assignment.ts` + `src/lib/contact-guard.ts` + `src/lib/policy.ts` + `src/lib/override-quota.ts` — the four gates
7. `src/app/api/drift/mine/route.ts` + `scripts/train_scorer.py` — the feedback loops
8. `src/components/help-bot.tsx` + `src/app/api/help/paper/route.ts` — the two assistants (sales-script vs paper-tutor) and why they share an icon but not a prompt

---

## 9. Operational cheatsheet

| Task | Where |
|------|-------|
| Add a new sales rep | `/settings` → Reps tab, or seed in `sales_reps` table |
| Change assignment rules | `/settings` → Assignment tab, writes to `system_config.lead_assignment` |
| Block a recipient permanently | Review mode → 🚩 Flag → severity=hard (senior+ only) |
| Kick off a training run | `/drift` → Human Signals → Train new model, OR `/scorer` → Train |
| See why a lead didn't send | `/logs` or `pipeline_leads.error_code` |
| Check today's override usage | Review mode → the "Override 7-day rule" label shows `N/200` |
| Run a migration | Supabase SQL Editor, paste `migrations/NNN-*.sql` |

---

## 10. Known gotchas

- **Drafts generated before 2026-04-22 may be missing the apply link.**
  The send-path round-trip was stripping `<a>` tags and signature
  styling. Fixed; 586 ready drafts are verified clean in the DB.
- **"0h old" label on a 4-day-old paper** was previously showing ingest
  age instead of paper age in review mode. Fixed; review meta now
  prefers `publishedAt` with ingest age in the tooltip.
- **If `override_used` column is missing** (migration 005 not run), every
  send will crash. Apply `migrations/005-override-used.sql`.
- **Skip used to discard in-flight edits.** Now persists `draftSubject` +
  `draftHtml` alongside `status='skipped'`, so un-skipping keeps the
  work.
- **The HelpBot has two modes.** Outside Review, it's the Sales Helper
  (grounded in Qiji facts + Sales Guide). In Review, it defaults to
  Paper Tutor mode, which is scoped to the current paper and refuses to
  write sales scripts. Switching modes clears the chat to prevent
  prompt-bleed between contexts.

---

*This doc is a snapshot; source of truth is always the code and
`SALES_RULES.md`. Update this when you touch architecture.*
