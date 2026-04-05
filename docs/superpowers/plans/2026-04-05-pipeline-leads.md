# Pipeline / Leads System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pipeline" section to the mail dashboard where arxiv papers are scraped daily, analyzed by AI, and saved as draft leads that the user can review, edit, and send from the UI.

**Architecture:** A `pipeline_leads` table stores leads with status (new → ready → sent → replied). A daily cron endpoint runs the arxiv scraper + Gemini analysis + draft generation pipeline, saving results to the DB. The Pipeline page shows leads grouped by status with send/edit/skip actions. Age-gating is enforced at the UI/send level (papers must be ≥1 day old to send), not at scrape time.

**Tech Stack:** Next.js 16 API routes, Supabase (direct client), Gemini API (google genai), arxiv API, Resend, Tailwind CSS 4, Recharts, Lucide icons.

---

## File Structure

```
src/
  app/
    pipeline/
      page.tsx                    # Pipeline page — lead review UI
    api/
      pipeline/
        route.ts                  # GET: list leads, POST: trigger scan
        [id]/
          route.ts                # GET: single lead, PATCH: update status/draft, DELETE
        send/
          route.ts                # POST: send a lead's draft email via Resend
        scan/
          route.ts                # POST: run arxiv scan + AI analysis (cron target)
  lib/
    scanner.ts                    # Arxiv fetch + PDF email extraction + Gemini analysis
    email-generator.ts            # Personalized email draft generation (Gemini)
    scanner-config.ts             # Categories, school data, surname list, directions
supabase-migration-pipeline.sql   # New table DDL
```

## Database: `pipeline_leads` Table

```sql
create table if not exists pipeline_leads (
  id text primary key default gen_random_uuid()::text,

  -- Paper info
  arxiv_id text unique not null,
  title text not null,
  abstract text,
  authors text,              -- comma-separated
  pdf_url text,
  published_at timestamptz,
  categories text,           -- comma-separated arxiv categories

  -- Lead info
  author_name text,          -- matched Chinese author name
  author_email text not null,
  first_name text,           -- for personalized greeting
  school_name text,
  school_tier int,

  -- AI analysis
  compute_level text,        -- heavy, moderate, light, none
  compute_confidence float,
  compute_reason text,
  matched_directions text,   -- comma-separated

  -- Email draft
  draft_subject text,
  draft_html text,

  -- Status & workflow
  status text not null default 'new',  -- new, ready, sent, skipped, replied
  source text not null default 'arxiv', -- arxiv, github, jike (future)

  -- Timestamps
  created_at timestamptz not null default now(),
  sent_at timestamptz,

  -- Dedup
  contact_history_key text   -- lowercase email for dedup against email_history
);

create index if not exists idx_pipeline_status on pipeline_leads(status);
create index if not exists idx_pipeline_email on pipeline_leads(author_email);
create index if not exists idx_pipeline_created on pipeline_leads(created_at);
create index if not exists idx_pipeline_source on pipeline_leads(source);
```

**Status flow:**
- `new` — scraped + analyzed, no draft yet (or draft generation failed)
- `ready` — draft generated, waiting for user review
- `sent` — user clicked Send, email delivered
- `skipped` — user clicked Skip
- `replied` — inbound email matched to this lead's author_email

---

### Task 1: Database Table + Migration

**Files:**
- Create: `supabase-migration-pipeline.sql`
- Modify: `src/app/api/setup/route.ts` (if it exists, to include new table)

- [ ] **Step 1: Create migration SQL file**

Create `supabase-migration-pipeline.sql` with the table DDL above.

- [ ] **Step 2: Run migration in Supabase**

Go to Supabase SQL Editor and execute the migration. Or use the setup endpoint if one exists.

- [ ] **Step 3: Commit**

```bash
git add supabase-migration-pipeline.sql
git commit -m "feat: add pipeline_leads table for outreach pipeline"
```

---

### Task 2: Scanner Config

**Files:**
- Create: `src/lib/scanner-config.ts`

- [ ] **Step 1: Create scanner config**

Extract from `resend0331.py` into TypeScript:
- `CATEGORIES` array
- `CHINESE_SURNAMES` set
- `SCHOOL_DATA` map
- `SUPPORTED_DIRECTIONS` map + `ALL_DIRECTIONS` flat array
- `APPLY_URL_CTA` and `WECHAT_ARTICLE_URL` constants

This is a pure data file — no logic, no tests needed.

- [ ] **Step 2: Commit**

```bash
git add src/lib/scanner-config.ts
git commit -m "feat: add scanner config (categories, schools, directions)"
```

---

### Task 3: Scanner Library

**Files:**
- Create: `src/lib/scanner.ts`

The scanner does three things:
1. Fetch papers from arxiv API (HTTP, not the Python `arxiv` library)
2. Extract emails from PDF first pages
3. Analyze with Gemini (author matching, compute needs, direction matching)

- [ ] **Step 1: Implement arxiv fetch**

Use the arxiv API's Atom feed: `http://export.arxiv.org/api/query?search_query=cat:cs.LG+OR+cat:cs.AI&sortBy=submittedDate&start=0&max_results=100`

Parse the XML response to extract paper objects.

- [ ] **Step 2: Implement PDF email extraction**

Fetch PDF, extract text from first page using a lightweight approach (regex on raw PDF bytes for email patterns — avoid heavy PDF libraries on Vercel serverless).

Alternative: Use the arxiv HTML page which often has author emails visible.

- [ ] **Step 3: Implement Gemini analysis**

Port the `analyze_paper_full` prompt from `resend0331.py` to TypeScript. Call Gemini API via the `google` genai SDK (already available as `GOOGLE_API_KEY` env var).

- [ ] **Step 4: Implement Chinese surname filter**

Port `likely_has_chinese_author()` from the Python script.

- [ ] **Step 5: Implement school lookup**

Port `get_school_info()` from the Python script.

- [ ] **Step 6: Export main `scanArxiv()` function**

```typescript
export async function scanArxiv(options: {
  maxPapers?: number;
  categories?: string[];
}): Promise<{
  leads: PipelineLead[];
  stats: { checked: number; filtered: number; leads: number; errors: string[] };
}>
```

This function orchestrates: fetch papers → filter (Chinese author, dedup) → extract emails → analyze with Gemini → return lead objects.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scanner.ts
git commit -m "feat: add arxiv scanner with Gemini analysis"
```

---

### Task 4: Email Draft Generator

**Files:**
- Create: `src/lib/email-generator.ts`

- [ ] **Step 1: Port email generation from Python**

Port `generate_email()`, `generate_third_paragraph()`, and the personalized intro Gemini prompt from `resend0331.py`.

Key function:
```typescript
export async function generateDraft(lead: {
  title: string;
  abstract: string;
  authorEmail: string;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  matchedDirections: string[];
}): Promise<{ subject: string; html: string }>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/email-generator.ts
git commit -m "feat: add email draft generator with Gemini personalization"
```

---

### Task 5: Pipeline API — Scan Endpoint

**Files:**
- Create: `src/app/api/pipeline/scan/route.ts`

- [ ] **Step 1: Create scan endpoint**

`POST /api/pipeline/scan` — triggers the full pipeline:
1. Call `scanArxiv()` to get leads
2. For each lead, check dedup (arxiv_id already in pipeline_leads? email already contacted?)
3. Generate email draft via `generateDraft()`
4. Insert into `pipeline_leads` with status `ready`
5. Return stats

Auth: require `CRON_SECRET` or internal referer (same pattern as `/api/sync`).

Time budget: 50s (Vercel Pro) or 8s (Hobby). Process in batches, return `complete: false` if time runs out.

- [ ] **Step 2: Add to vercel.json cron**

Add a daily cron entry:
```json
{
  "path": "/api/pipeline/scan",
  "schedule": "0 6 * * *"
}
```
(6 AM UTC = early morning for papers from overnight)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/pipeline/scan/route.ts vercel.json
git commit -m "feat: add pipeline scan endpoint with daily cron"
```

---

### Task 6: Pipeline API — CRUD + Send

**Files:**
- Create: `src/app/api/pipeline/route.ts`
- Create: `src/app/api/pipeline/[id]/route.ts`
- Create: `src/app/api/pipeline/send/route.ts`

- [ ] **Step 1: Create list endpoint**

`GET /api/pipeline?status=ready&page=1&limit=50` — list leads with pagination and status filter.

Return camelCase mapped fields.

- [ ] **Step 2: Create single lead endpoint**

`GET /api/pipeline/[id]` — get full lead detail.
`PATCH /api/pipeline/[id]` — update draft_subject, draft_html, status.
`DELETE /api/pipeline/[id]` — remove lead.

- [ ] **Step 3: Create send endpoint**

`POST /api/pipeline/send` with `{ id }`:
1. Fetch lead from DB, verify status is `ready`
2. Check age gate: `published_at` must be ≥ 1 day ago
3. Send via Resend API (same pattern as `/api/send`)
4. Save to `emails` table (so it shows in Emails page)
5. Update lead status to `sent`, set `sent_at`
6. Return success

- [ ] **Step 4: Commit**

```bash
git add src/app/api/pipeline/
git commit -m "feat: add pipeline CRUD and send endpoints"
```

---

### Task 7: Pipeline Page — UI

**Files:**
- Create: `src/app/pipeline/page.tsx`
- Modify: `src/components/sidebar.tsx` (add Pipeline nav item)

- [ ] **Step 1: Add Pipeline to sidebar**

Add between Inbox and Logs:
```typescript
{ href: "/pipeline", label: "Pipeline", icon: Zap },
```

- [ ] **Step 2: Create Pipeline page**

Layout:
- Header: "Pipeline" title + "Scan Now" button + stats (X ready, Y sent today)
- Status tabs: All | Ready | New | Sent | Skipped
- Lead cards in a list, each showing:
  - Author name + email + school badge
  - Paper title (linked to arxiv)
  - Compute level badge (heavy=red, moderate=yellow, light=green)
  - Matched directions as small tags
  - Age indicator: "2d ago" or "⏳ Available in 14h" if <1 day old
  - Action buttons: [Send] [Edit] [Skip]
- Clicking a lead expands to show:
  - Full abstract
  - Draft email preview (rendered HTML on white bg)
  - Edit draft (subject + HTML textarea)

Key behaviors:
- "Send" button disabled if paper < 1 day old (age gate)
- "Send" calls `POST /api/pipeline/send`
- "Skip" calls `PATCH /api/pipeline/[id]` with status=skipped
- "Scan Now" calls `POST /api/pipeline/scan` and shows progress
- Auto-refresh lead list after send/skip

- [ ] **Step 3: Commit**

```bash
git add src/app/pipeline/page.tsx src/components/sidebar.tsx
git commit -m "feat: add Pipeline page with lead review UI"
```

---

### Task 8: Auto-Reply Matching

**Files:**
- Modify: `src/app/api/webhook/route.ts`
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Match inbound emails to pipeline leads**

When an `email.received` webhook arrives or inbound email is synced:
1. Extract sender email from the `from` field
2. Look up `pipeline_leads` where `author_email` matches and `status = 'sent'`
3. If found, update status to `replied`

This auto-tracks which leads responded.

- [ ] **Step 2: Commit**

```bash
git add src/app/api/webhook/route.ts src/lib/sync.ts
git commit -m "feat: auto-match inbound replies to pipeline leads"
```

---

### Task 9: Integration Test — End to End

- [ ] **Step 1: Manual test flow**

1. Hit `POST /api/pipeline/scan` (with a small `maxPapers=10` param)
2. Verify leads appear in the Pipeline page
3. Review a draft, click Send
4. Verify it appears in the Emails page
5. Verify the lead status updated to `sent`

- [ ] **Step 2: Deploy to Vercel**

```bash
npx vercel --prod
```

- [ ] **Step 3: Verify cron is registered**

Check Vercel dashboard → Crons tab to confirm `/api/pipeline/scan` appears.

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat: complete pipeline system - arxiv scan, draft, review, send"
```

---

## Future Tasks (Not In This Plan)

- **GitHub startup source**: Integrate `github-startup-finder` pipeline as a second source
- **Jike founder source**: Integrate `jike-founder-radar` as a third source
- **Batch send**: Select multiple leads and send all at once
- **Email history dedup**: Check against `email_history.json` from the Python script
- **Pipeline analytics**: Chart of leads found / sent / replied over time on Overview page
