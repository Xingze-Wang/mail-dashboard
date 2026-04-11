# Lead Assignment & Sales Rep System

**Date:** 2026-04-11
**Status:** Draft

## Problem

All leads currently go to one sender (Leo). To scale outreach with 2-3 sales reps, we need:
1. Researcher quality signal (beyond compute need) to classify leads as strong/normal
2. Configurable assignment of leads to reps, with manual override
3. Analytics to compare channel quality and rep performance

## Scope

### In scope
- Semantic Scholar enrichment (h-index, citations) during arXiv scan
- Sales rep configuration (name, email, wechat, domain)
- Auto-assignment rules (configurable thresholds) + manual override
- Email draft generation using assigned rep's identity
- Pipeline page: three tabs (Leads, Channels, Sales)

### Out of scope
- Multi-source scraping (only arXiv for now)
- Scorer model improvements
- Automated re-assignment optimization

---

## 1. Semantic Scholar Enrichment

### Data flow

During `scanArxiv()`, after Gemini analysis identifies the target author + email:

1. Search Semantic Scholar API by author name + paper title
2. Extract: `h_index`, `citation_count`, `paper_count`
3. Store on `pipeline_leads` row

### Semantic Scholar API

**Endpoint:** `GET https://api.semanticscholar.org/graph/v1/paper/search`
- Search by paper title to find the paper
- Then get author details from the paper's author list

**Endpoint:** `GET https://api.semanticscholar.org/graph/v1/author/{authorId}`
- Fields: `hIndex`, `citationCount`, `paperCount`

**Rate limit:** 100 requests/5 minutes without API key, 1 request/second with key. We process ~50-100 leads per scan, so this is fine without a key. Add 1-second delay between calls.

**Fallback:** If Semantic Scholar lookup fails (author not found, API error), store `null` for all fields. Lead still enters pipeline — enrichment is best-effort.

### Schema changes to `pipeline_leads`

```sql
ALTER TABLE pipeline_leads ADD COLUMN s2_author_id TEXT;
ALTER TABLE pipeline_leads ADD COLUMN h_index INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN citation_count INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN paper_count INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN lead_tier TEXT DEFAULT 'normal';  -- 'strong' | 'normal'
ALTER TABLE pipeline_leads ADD COLUMN assigned_rep_id INTEGER;
```

---

## 2. Sales Rep Configuration

### `sales_reps` table

```sql
CREATE TABLE sales_reps (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,              -- Display name (e.g. "Leo")
  sender_email TEXT NOT NULL,      -- e.g. "leo@compute.miracleplus.com"
  sender_name TEXT NOT NULL,       -- e.g. "Leo"
  wechat_id TEXT NOT NULL,         -- e.g. "Lorenserus1"
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Initial data: insert current Leo as rep #1. Add 1-2 more when ready.

### Email generation changes

`email-generator.ts` `generateDraft()` currently hardcodes:
- `process.env.SENDER_NAME` / `process.env.SENDER_EMAIL` in send route
- `Lorenserus1` WeChat ID in email body
- `Leo\n奇绩创坛` signature

Change: `generateDraft()` accepts a `rep` parameter with `{ name, wechat_id }`. The send route looks up the assigned rep and uses their `sender_email` / `sender_name` for the Resend `from` field.

---

## 3. Lead Assignment

### Assignment rules

Stored in a `assignment_config` JSON column on a single-row config table, or simpler: a `assignment_rules` table.

Simpler approach — a single config object stored in a `system_config` table:

```sql
CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

The `lead_assignment` config entry:

```json
{
  "strong_criteria": {
    "min_h_index": 20,
    "max_school_tier": 2,
    "require_overseas": true
  },
  "assignment": {
    "strong": { "rep_id": 1 },
    "normal": { "rep_ids": [2, 3], "mode": "round_robin" }
  }
}
```

### Classification logic

A lead is **strong** if ALL of:
- `h_index >= strong_criteria.min_h_index` (default: 20)
- `school_tier <= strong_criteria.max_school_tier` (default: 2)
- If `require_overseas` is true: school domain is NOT `.cn` 

Otherwise **normal**.

If Semantic Scholar data is missing (`h_index = null`), lead is classified as **normal**.

### Assignment flow

1. Lead enters pipeline from scan → enriched with S2 data
2. Classification: strong or normal based on config
3. Assignment: strong → designated rep, normal → round-robin among designated reps
4. `assigned_rep_id` and `lead_tier` written to `pipeline_leads`
5. Draft generated with assigned rep's identity

### Manual override

On the pipeline Leads tab, each lead row shows:
- Current assigned rep (dropdown to change)
- Current lead tier badge ("strong" / "normal")

Changing the rep dropdown calls `PATCH /api/pipeline/[id]` with `{ assigned_rep_id: newId }`. This is a manual override — won't be re-assigned by future rule changes.

Optionally: a "Re-assign all" button that re-runs classification + assignment on all `status = 'ready'` leads using current rules.

---

## 4. Pipeline UI — Three Tabs

### Tab 1: Leads (existing, enhanced)

Current pipeline page with additions:
- **New columns:** h-index, citations, lead tier badge, assigned rep
- **New filters:** filter by rep, filter by tier
- **Rep dropdown** on each row for manual override
- Everything else stays the same (status filter, send button, batch send, etc.)

### Tab 2: Channels

Summary analytics for lead sources. Currently only arXiv, but structured to support future sources.

**Cards row:**
- Total leads (all time)
- Leads this week
- Avg h-index of leads
- Overall send → WeChat conversion rate

**Table: Source breakdown**

| Source | Total | Strong | Normal | Sent | Replied | WeChat | Conversion % |
|--------|-------|--------|--------|------|---------|--------|-------------|
| arXiv  | 342   | 48     | 294    | 280  | 31      | 14     | 5.0%        |

(Single row for now. Ready for more sources later.)

**Chart:** Leads discovered per day (last 30 days), stacked by tier.

**Quality distribution:** h-index histogram of discovered leads.

### Tab 3: Sales

Per-rep performance dashboard.

**Rep cards** (one per active rep):
- Name, email, WeChat
- Total assigned / sent / replied / WeChat converted
- Conversion rate (sent → WeChat)
- Avg response time

**Table: Rep x Lead Type matrix**

| Rep | Tier | Assigned | Sent | Replied | WeChat | Conv % | Avg Days to WeChat |
|-----|------|----------|------|---------|--------|--------|-------------------|
| Leo | strong | 48 | 45 | 12 | 8 | 17.8% | 3.2 |
| Leo | normal | 50 | 48 | 5  | 2 | 4.2%  | 5.1 |
| Rep B | normal | 100 | 95 | 8 | 3 | 3.2% | 4.8 |

**Chart:** Conversion rate by rep over time (weekly rolling).

### Data sources for analytics

All data already exists or can be derived:
- Lead counts: `pipeline_leads` grouped by `source`, `lead_tier`, `assigned_rep_id`
- Sent: `pipeline_leads WHERE status = 'sent'`
- Replied: join with `inbound_emails` on author_email
- WeChat: `brief_lookups WHERE added_wechat = true`
- Response time: `sent_at` to first inbound email timestamp

---

## 5. Settings Page Addition

A new section on a settings page (or a sub-tab in Pipeline) for:
- **Sales reps:** CRUD (add/edit/deactivate reps)
- **Assignment rules:** configure strong criteria thresholds + which rep handles which tier
- **"Re-assign all"** button to re-run assignment on unprocessed leads

This can be a simple form — no need for a visual rules builder.

---

## 6. API Changes Summary

| Endpoint | Change |
|----------|--------|
| `POST /api/pipeline` (scan) | Add S2 enrichment, classification, assignment |
| `PATCH /api/pipeline/[id]` | Support `assigned_rep_id` update |
| `POST /api/pipeline/send` | Use assigned rep's sender identity |
| `POST /api/pipeline/batch-send` | Same — use per-lead rep identity |
| `GET /api/pipeline` | Return new fields, support `rep_id` and `tier` filters |
| `GET /api/sales-reps` | NEW — list reps |
| `POST /api/sales-reps` | NEW — create/update rep |
| `GET /api/pipeline/analytics` | NEW — channel + sales analytics data |
| `GET /api/config/assignment` | NEW — get assignment rules |
| `PUT /api/config/assignment` | NEW — update assignment rules |

---

## 7. Implementation Order

1. **DB migrations** — new columns on `pipeline_leads`, new tables (`sales_reps`, `system_config`)
2. **Semantic Scholar client** — `src/lib/semantic-scholar.ts` with author lookup
3. **Assignment engine** — `src/lib/assignment.ts` with classify + assign logic
4. **Scanner integration** — wire S2 enrichment + assignment into `scanArxiv()`
5. **Email generator** — accept rep identity parameter
6. **Send routes** — use assigned rep's sender identity
7. **API routes** — sales reps CRUD, config endpoints, analytics endpoint
8. **Pipeline UI** — three tabs (Leads enhancements, Channels, Sales)
9. **Settings UI** — rep management + assignment rules config
