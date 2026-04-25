# Qiji Pipeline: Complete Product Overview

## Executive Summary

**Qiji Pipeline** is a full-stack Next.js application that automates GPU compute grant outreach to Chinese AI researchers. It runs daily arXiv scans, enriches leads with academic metadata, intelligently routes qualified candidates to sales representatives, generates personalized emails via Resend, and tracks conversions through WeChat interactions.

The product serves a sales team that needs to move fast: from 300+ new arXiv papers each day to sent emails and WeChat confirmations, with continuous feedback loops for prompt optimization and conversion prediction.

Deployment: https://qiji-pipeline.vercel.app

---

## 1. What the Product Does

### 1.1 Business Goal

Qiji Compute offers a free GPU grant to Chinese AI researchers building cutting-edge models (robotics, 3D generative, world models, etc.). The Pipeline automates the discovery and outreach workflow:

1. **Find researchers** who match Qiji's technical directions
2. **Rank them** by academic impact and likelihood to respond
3. **Route to the right rep** (strong leads to senior reps, normal leads by geography)
4. **Send personalized outreach** within 24 hours of paper publication
5. **Convert on WeChat** and track who closed each deal

### 1.2 Key Users

**Sales Representatives** (Leo, Chenyu, Ethan):
- Browse incoming leads on the Pipeline page (`/pipeline`)
- Review drafts, customize and send via `/emails` page
- Record WeChat conversions using the "Brief" panel (right sidebar on `/emails`)
- Chat with the helper bot (`/help`) for lead lookups, stats, and batch operations

**Admin** (internal):
- Monitor lead assignment rules and rep performance at `/scorer` (conversion model)
- Review LLM-detected prompt patterns at `/drift` (sales edits vs. AI drafts)
- Tune the logistic regression conversion scorer for P(WeChat conversion)

### 1.3 Daily Workflow for a Sales Rep

1. **6 AM UTC**: Cron job runs (`/api/cron`):
   - Syncs sent/inbound emails from Resend webhooks
   - Scans arXiv for new papers in target categories (cs.LG, cs.AI, cs.CV, cs.CL, cs.RO, stat.ML)
   - Enriches authors with Semantic Scholar h-index/citation data
   - Classifies leads as "strong" or "normal" based on citations and school tier
   - Assigns to Leo, Chenyu, or Ethan
   - Generates draft emails with rep identity
   - Mines prompt patterns from yesterday's sales edits

2. **9 AM**: Rep opens `/pipeline` page:
   - Sees 50-100 new leads (cards) assigned to them
   - Filters by status (ready, sent, skip), rep, or discovery source (arXiv / Hugging Face / GitHub / Product Hunt)
   - Clicks into Browse mode to scan one by one

3. **Outreach Workflow**:
   - If draft is good: sends immediately via Resend (emails table + rep_id stamp)
   - If draft needs tweaks: edits it, hits Send (sales edit recorded in `draft_edit_distance` / `edit_reasons`)
   - If lead is bad: clicks Skip (status → "skip", lead still tracked for analysis)

4. **Later that day / week**: Researcher replies or DMs on WeChat:
   - Rep clicks "Added on WeChat" in the brief panel (right sidebar on `/emails`)
   - System records `brief_lookups` row with `marked_by_rep_id` = who clicked
   - **Key insight**: conversion is attributed to **who clicked the button**, not lead owner
   - Analytics credit that rep with a conversion

5. **Admin reviews trends**:
   - `/scorer` page shows live conversion model: which features (h-index, school tier, compute confidence) best predict WeChat adds
   - `/drift` page shows patterns LLM extracted from rep edits (e.g., "rep always swaps 'offer' for 'opportunity'")

---

## 2. Lead Discovery → Enrichment → Routing → Outreach Pipeline

### 2.1 Lead Sources

#### arXiv (primary)
- **Scanner**: `/src/lib/scanner.ts` runs daily, fetches last 24h of new papers
- **Categories**: cs.LG, cs.AI, cs.CV, cs.CL, cs.RO, stat.ML
- **Directions**: 70+ hardcoded research areas (e.g., "4D重建生成", "具身导航感知", "多模态世界模型")
- **Matching**: NLP classifier detects if paper abstract / title matches Qiji's directions
- **Confidence**: `compute_level` (heavy/moderate/light) + numeric `compute_confidence` + free-text `compute_reason`
- **Stored in**: `pipeline_leads` table

#### Discovery Sources (emerging)
- **Hugging Face**: trending model repos by author
- **GitHub**: starred ML repos by author
- **Product Hunt**: launched AI tools by maker
- **Stored in**: `discovery_leads` table (separate, with `source` = "hf" / "ph" / "github")
- **UI**: `/pipeline` page tabs out discovery cards alongside arXiv leads

### 2.2 Lead Enrichment

Once a researcher is found (from any source), the system enriches their profile:

#### Semantic Scholar Lookup (`/src/lib/semantic-scholar.ts`)
- Query Semantic Scholar API by paper title + author name
- Returns: `h_index`, `citation_count`, `paper_count`, `authorId`
- **Best effort**: if lookup fails, pipeline continues (non-blocking)
- **Used for**: classifying lead tier

#### School Tier (`/src/lib/scanner-config.ts`)
- Extract email domain from author email
- Match against curated school list (40+ institutions, 3-tier system):
  - **Tier 1**: MIT, Stanford, Berkeley, CMU, Harvard, Tsinghua, PKU, etc.
  - **Tier 2**: Georgia Tech, CMU, UChicago, HKUST, SJTU, Zhejiang, etc.
  - **Tier 3**: Other verified institutions (CAS, BUAA, etc.)
- If no match: tier = null

#### Author Parsing (`/src/lib/scanner.ts`)
- Extract first name, last name from arXiv metadata
- Detect if surname is Chinese (matches 150+ pinyin surnames) → flag as likely China-based
- Detect school from email domain
- **Note**: School tier trumps geo-detection when available

### 2.3 Lead Classification: Strong vs. Normal

**Trigger**: After enrichment, `classifyLead()` in `/src/lib/assignment.ts` assigns a tier.

**Rules** (from `SALES_RULES.md`):
- A lead is **Strong** if:
  - `citation_count > 2000`, OR
  - `school_tier IN (1, 2)` (Tier 1 or Tier 2 school)
- Otherwise: **Normal**

**Stored in**: `pipeline_leads.lead_tier` column.

### 2.4 Lead Assignment to Sales Reps

**Trigger**: After tier is decided, `assignRep()` in `/src/lib/assignment.ts` routes the lead.

**Rules**:
1. **Strong tier** → **Leo** (rep_id = 1)
   - Leo is the senior rep handling high-impact researchers
2. **Normal tier + overseas** (email domain ≠ .cn) → **Ethan** (rep_id = 3)
   - International researchers (MIT, Stanford, etc.)
3. **Normal tier + domestic** (email domain = .cn) → **Chenyu** (rep_id = 2)
   - China-based researchers

**Config**: Stored in `system_config` table, key = `"lead_assignment"`. Can be updated via `/api/config/assignment` endpoint.

**Assignment columns** stored in `pipeline_leads`:
- `assigned_rep_id`: the rep who "owns" the lead (used for filtering on `/pipeline`)
- `lead_tier`: "strong" or "normal" classification

### 2.5 Draft Email Generation

**Trigger**: During cron, for each newly classified lead, `generateDraft()` in `/src/lib/email-generator.ts` creates an initial outreach email.

**Inputs**:
- Paper metadata (title, abstract, authors)
- Author first name, school, school tier
- Matched research directions
- Rep identity (name, WeChat ID)

**Output**:
- `draft_subject`: email subject
- `draft_html`: HTML email body
- **Stored in**: `pipeline_leads.draft_subject` and `pipeline_leads.draft_html`
- **Status**: If draft succeeds, `pipeline_leads.status = "ready"` (rep can send). Otherwise `"new"` (manual draft).

**Note**: Draft is **not** sent to Resend yet. Rep reviews it first.

### 2.6 Email Send & Tracking

**Rep Action**: On `/emails` page, rep reviews draft, optionally edits, clicks "Send".

**What happens**:
1. API call to `/api/send` (requires `requireSession()` — role re-read from DB on every request)
2. Creates `Email` row with `from`, `to`, `subject`, `html`
3. Sends via Resend API, stores `resendId` (Resend's message ID)
4. If rep edited: compute `draft_edit_distance` (Levenshtein), store `edit_reasons` tags (free-text array)
5. Updates `pipeline_leads.status = "sent"`, `sent_at = now()`, `rep_id = current_rep`

**Resend Webhooks**:
- Resend fires webhooks for `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`
- `/api/inbound/webhook` receives them
- Creates `WebhookEvent` row (canonical history of events)
- Updates `Email.status` to latest event (but `WebhookEvent` is the source of truth)

**Thread Support**:
- Each `Email` has `messageId` (Resend's Message-ID header)
- `inReplyTo` and `references` fields for threading
- `threadId` for grouping related emails

---

## 3. WeChat Conversion Loop: Brief Lookups & Attribution

### 3.1 The Brief Panel

When a rep opens `/emails` page and selects an email, a right-side panel ("Brief") appears showing:
- Paper metadata (title, authors, arXiv link)
- Lead information (name, school, compute classification)
- Outreach status (to whom, when sent)
- **"Added on WeChat" button**

### 3.2 Recording a Conversion

When rep clicks "Added on WeChat":

1. **API Call**: POST `/api/brief/wechat` with:
   - Researcher email address
   - Rep ID (from session)
   - Optional lead_id / arxiv_id (if matched to a `pipeline_leads` row)

2. **Database Action**: Insert `brief_lookups` row:
   - `email`: researcher's email
   - `marked_by_rep_id`: **ID of the rep who clicked the button**
   - `marked_at`: timestamp
   - `lead_id`: optional FK to pipeline_leads

3. **Analytics Impact**:
   - Conversion is credited to `marked_by_rep_id` (not the original lead owner)
   - **Why**: Multiple reps may collaborate; whoever closes it gets credit
   - Score for `marked_by_rep_id` goes up by 1 conversion

### 3.3 The Attribution Model: "Actor vs. Lead-Owner"

**Important asymmetry**:
- **Lead ownership**: determined at discovery time (`assigned_rep_id` in `pipeline_leads`)
- **Conversion ownership**: determined at WeChat interaction time (`marked_by_rep_id` in `brief_lookups`)

Example:
- arXiv paper published → cron assigns to Chenyu (lead_tier = normal, email = @qq.com)
- Chenyu sends draft, but gets busy
- Leo later replies to researcher's WeChat DM
- Leo clicks "Added on WeChat" → conversion credited to Leo, not Chenyu

**Why this design**:
- Sales is fluid; team members help each other
- The person who completes the deal should get the credit
- Lead ownership is just routing for the initial outreach

### 3.4 Brief Lookups Table

Table: `brief_lookups`
- `id`: UUID, primary key
- `email`: researcher's email address
- `marked_by_rep_id`: sales rep ID who recorded the conversion
- `marked_by_email`: rep's email (denormalized for audit)
- `marked_at`: timestamp
- `lead_id`: optional FK to `pipeline_leads.id` (if this researcher was a lead)
- `arxiv_id`: optional arXiv paper ID

Used by:
- `/scorer` page: conversion model training (positive label)
- `/api/brief` GET: fetch paper context when rep opens an email
- Admin analytics: per-rep conversion rates

---

## 4. The Helper Bot ("老师傅"): Sales-Facing AI Assistant

**Location**: Accessible via chat icon in sidebar, or embedded at `/help`.

**Design Philosophy**: Evidence-first, tools as proposals, single-turn LLM with optional 2nd round.

### 4.1 Tool System

Two categories:

#### READ Tools (auto-execute)
Auto-run server-side before LLM generates final answer. Safe, no user confirmation needed.
- **`list_leads`**: fetch rep's assigned leads (filtering by status, tier, etc.)
- **`get_lead`**: fetch single lead details (paper, enrichment, outreach status)
- **`get_my_stats`**: rep's personal stats (leads sent this week, conversion rate, override quota used)
- **`get_rep_info`**: rep name, email, WeChat ID, active status

#### ACTION Tools (proposals)
Require user confirmation before execution. LLM generates a JSON proposal block, UI renders a confirm card.
- **`batch_send`**: send N leads (with optional template override)
- **`skip_lead`**: mark lead status = "skip"
- **`flag_lead`**: mark lead for manual review (QA issue)
- **`redraft_lead`**: regenerate email draft for a specific lead
- **`bulk_flag`**: flag multiple leads by criteria
- **`review_next`**: show next lead in queue (pagination helper)
- **`build_rep_template`**: generate a personal rep template based on recent sends

### 4.2 Agent Loop

**POST `/api/help/ask`**:

1. **LLM Turn 1**:
   - System prompt: context (Qiji program facts, sales guide, patterns, past learnings)
   - User question
   - Tools prompt (description of each tool)
   - Model: Claude Opus 4.7 (or fallback Gemini)
   - Output: LLM text + optional `lookup ...` blocks (read tool calls) + optional `tool ...` JSON proposal

2. **Server Processing**:
   - Extract and execute all `lookup` blocks (read tools)
   - Collect results

3. **LLM Turn 2** (if lookups ran):
   - Same system prompt, plus results from lookups
   - User original question + lookup results as context
   - LLM produces final answer + optional tool proposal

4. **Confirmation UI**:
   - If tool proposal exists, render confirm card (shows action + parameters)
   - Rep clicks Confirm → executes action
   - Action result stored in `helper_conversations` table

**Persistence**:
- If `conversationId` provided, store all messages + tool proposals in `helper_conversations` + `helper_messages` tables
- Rep can review conversation history at `/help` page

### 4.3 Evidence System

Any **numeric claim** must be tagged with evidence. Format:

```
这个 rep 今周发了 42 条邮件。[E1]

[E1]: 数据来自 /api/help/ask 的 get_my_stats 工具，统计 leads_sent_week = 42，查询时间 2026-04-24T15:33:00Z
```

**Why**:
- Prevents LLM from hallucinating numbers
- Admin can audit bot answers
- Clear chain from claim → data source → rep

### 4.4 Tool Read Implementation

**File**: `/src/lib/helper-read-tools.ts`

Each read tool is a server-side function that:
1. Validates rep_id (from session)
2. Queries database
3. Returns JSON result
4. Checks authorization (can rep see this lead? is rep in this rep_id?)

Example: `get_lead(lead_id)` fetches `pipeline_leads` row if:
- Lead belongs to rep's assigned pool, OR
- Rep is admin, OR
- Rep is on the same team

---

## 5. Drift Mining: Extracting Prompt Patterns from Sales Edits

### 5.1 The Drift Problem

Sales reps consistently edit AI-generated drafts in predictable ways:
- "Dear Researcher" → "Hi Dr. Wang"
- "GPU computing resources" → "free GPU compute"
- Reordering paragraphs, changing tone

If the system doesn't adapt, each day's drafts are slightly misaligned with what reps actually send.

### 5.2 Drift Mining Process

**Trigger**: Daily cron (step 3), calls `runDriftMine()` in `/src/app/api/drift/mine/route.ts`.

**Inputs**:
- All `pipeline_leads` sent in last 30 days where `draft_edit_distance > 0` (rep edited)
- Max 120 leads (budget constraint for LLM call)
- Extract `draft_original_html` (AI version) and `draft_html` (rep's version)
- Parse HTML → text for comparison

**LLM Analysis**:
- Send pairs to Claude Opus 4.7 (with fallback to Gemini)
- System prompt: "Extract common patterns where sales edits the AI draft"
- LLM identifies recurring changes (e.g., "AI says 'collaborate', rep changes to 'partner'")
- Output: JSON with `patterns[]` array

**Storage**: Insert into `prompt_drift_patterns` table:
- `ai_phrase`: what the AI wrote
- `sales_phrase`: what the rep changed it to
- `category`: type of change (tone, terminology, structure, etc.)
- `occurrence_count`: how many times this pattern was observed
- `example_lead_ids`: list of 3-5 examples
- `status`: "pending" (admin must review before accepting)

**Admin Review**: `/drift` page shows all pending patterns, allows admin to:
- **Accept**: mark status = "accepted", triggers prompt update for next day's drafts
- **Ignore**: mark status = "ignored", don't change the prompt
- **Edit**: refine the pattern before accepting

### 5.3 Pattern Application

Once accepted, patterns feed into:
1. **Prompt for next day's drafts**: system prompt includes accepted patterns as examples
2. **Model retraining signals**: help identify which features of the lead predict successful reps edits

---

## 6. The Scorer: Conversion Prediction Model

### 6.1 What Gets Scored

Every lead (pipeline or discovery) gets a **local_score** (0-1 float) predicting P(will convert to WeChat).

**Positive Label**: A brief_lookup entry with `marked_by_rep_id` (rep clicked "Added on WeChat").

**Negative Label**: Lead sent 14+ days ago with no brief_lookup entry.

**Neutral**: Leads sent < 14 days ago (not enough time for response).

### 6.2 Logistic Regression Model

**File**: `/src/lib/logistic.ts`

Minimal in-process logistic regression (no external libraries). Trained on ~500-2000 leads, ~15 features.

**Features**:
- `h_index` (from Semantic Scholar)
- `citation_count`
- `school_tier_1` (binary)
- `school_tier_2` (binary)
- `compute_level_heavy` (binary)
- `compute_level_moderate` (binary)
- `compute_confidence` (0-1)
- `days_since_paper_published`
- `is_chinese_author` (detected from email domain)
- Plus 5-6 more direction/category indicators

**Training**:
- Split: 80% train, 20% held-out test
- Optimizer: SGD with L2 regularization
- Loss: binary cross-entropy
- Metrics: AUC, precision, recall (reported at `/scorer`)
- Dual target: weight WeChat conversions higher than generic clicks (sample weights in fitLR)

**API**: 
- **POST `/api/scorer`**: train a new model from accumulated signals
- **GET `/api/scorer`**: fetch latest model metadata (features, coefficients, CV stats)
- **GET `/api/scorer/match`**: score a single lead

### 6.3 Scorer Dashboard (`/scorer` page)

Tabs:

1. **Lead Tab** ("Lead Scoring"):
   - Live model metadata (n_samples, F1 score, feature importances as bar chart)
   - Distribution histogram (score bins)
   - Top pending leads (highest score, not yet sent)
   - Biggest misses (sent, low score, converted anyway)
   - Hidden wins (not sent, would have converted)
   - By-category breakdown (directions: "4D重建生成", etc.)

2. **Email Quality Tab** ("Email Quality"):
   - Side-by-side comparison of AI draft vs. rep edits
   - Edit distance heatmap
   - Most common edits by rep

3. **Conversion Analysis Tab** ("Conversion Analysis"):
   - Calibration curve: for each score bin, shows actual conversion rate
   - P(convert | score) → can tell admin if score = 0.7 really means 70%
   - Optionally compare to Gemini's independent scoring (disagreement detection)

4. **Match Tab** ("Match Quality"):
   - For each supported direction, show:
     - How many leads matched that direction
     - Conversion rate for that direction
     - Quality signal (how predictive is matching that direction)

### 6.4 Retrain Flow

**Trigger**: Cron step 4, `emitRetrainSignals()` in `/src/lib/retrain-signals.ts`.

**Logic**:
- Count new conversions since last retrain
- If >= threshold (e.g., 20 new signals), emit a proposal
- Build proposal JSON showing: old model AUC, estimated new AUC, improvement delta
- Store in `retrain_proposals` table

**Admin Action**: At `/api/retrain/proposal`, admin can:
- Review latest proposal
- Click "Retrain" → POST `/api/scorer` to fit a new model
- Or "Skip" → wait for more signals

---

## 7. Authentication Model

### 7.1 Session and JWT

**File**: `/src/lib/auth.ts` (not in repo, inferred from usage):
- JWT cookie: `AUTH_COOKIE` (30-day expiration)
- Payload: `{ repId, repName, email, role }`
- Issued at login: `/app/(auth)/login/page.tsx`

**Roles**:
- `"admin"`: full access, can delete leads, adjust config, review drift
- `"senior"`: can flag leads, block list, review patterns
- `"sales"`: read own assigned leads, send, record conversions

### 7.2 Per-Request Role Re-read

**Critical Design**: Role is **never trusted from JWT**.

**File**: `/src/lib/auth-helpers.ts`, `requireSession()` function.

On **every API request**:
1. Extract JWT cookie, verify signature
2. Query `sales_reps` table for current `role` and `active` status
3. If role changed (demoted from admin to sales) **since login**, new role takes effect immediately
4. If rep deleted or inactive, 401 Unauthorized

**Why**: A 30-day JWT cookie could allow a demoted user to keep admin access. Re-reading the DB every request prevents this.

### 7.3 Account Stacking ("Pool Cookie")

Some deployments use a separate "pool" cookie for switching between rep accounts (for testing). Not central to production flow, but mentioned in `/src/middleware.ts` logic.

### 7.4 Middleware and Route Protection

**File**: `/src/middleware.ts`

Public routes (no session required):
- `/login`, `/api/auth/*`, `/api/cron`, `/_next`, `/favicon`
- `/api/inbound` POST only (Resend webhook — protected by `INBOUND_SECRET` bearer token instead)

Protected routes (session required):
- All `/api/pipeline/*`, `/api/emails/*`, `/api/scorer/*`, etc.
- All pages except login

Machine-to-Machine:
- `/api/pipeline/import` and `/api/pipeline/record` accept `Authorization: Bearer $PIPELINE_IMPORT_KEY` (Python scraper)

---

## 8. Daily Cron: The Heartbeat

**Endpoint**: `GET /api/cron?Authorization: Bearer $CRON_SECRET`

**Trigger**: Vercel cron (or external service) calls once per weekday at 6 AM UTC.

**Execution Steps** (in `/src/app/api/cron/route.ts`):

1. **Sync from Resend** (best-effort):
   - Fetch all webhook events since last sync
   - Update `Email.status` based on latest event
   - Sync inbound emails (replies) to `InboundEmail` table

2. **Scan arXiv** (300 papers max, 40s time budget):
   - Fetch last 24h of new papers (all categories)
   - For each paper:
     - Parse author emails, names
     - Detect school tier from email domain
     - Classify compute relevance (NLP)
     - Enrich with Semantic Scholar (h-index, citations) — best effort
     - Classify tier (strong/normal)
     - Assign to rep
     - Generate draft (AI model)
   - Insert as `pipeline_leads` rows

3. **Drift Mine** (60 leads, 30-day lookback):
   - Find all `pipeline_leads` sent with edits (`draft_edit_distance > 0`)
   - Send to LLM for pattern extraction
   - Insert pending patterns into `prompt_drift_patterns`

4. **Emit Retrain Signals**:
   - Count new conversions
   - Build proposal if threshold met
   - Store proposal metadata

**Failure Handling**:
- Each step is independent (try/catch)
- Failure in one step doesn't block others
- Retrain signals is lowest-priority (fails silently if LLM times out)
- Returns JSON with results/errors for each step

---

## 9. Data Model Highlights

### 9.1 Core Tables

**`pipeline_leads`** (arXiv papers & enrichment):
- `id`: CUID
- `arxiv_id`, `title`, `abstract`, `authors`, `pdf_url`
- `author_name`, `author_email`, `first_name`
- `school_name`, `school_tier`: (1, 2, 3, or null)
- `compute_level`, `compute_confidence`, `compute_reason`: NLP classification
- `matched_directions`: array of matching research areas
- `s2_author_id`, `h_index`, `citation_count`, `paper_count`: Semantic Scholar enrichment
- `lead_tier`: "strong" or "normal" classification
- `assigned_rep_id`: FK to `sales_reps.id`
- `draft_subject`, `draft_html`: initial AI draft
- `draft_original_subject`, `draft_original_html`: copy before rep edits
- `draft_model`: which LLM generated this draft
- `draft_edit_distance`, `edit_reasons`: Levenshtein distance + tags
- `status`: "new" | "ready" | "sent" | "skip" | "bounced"
- `sent_at`, `created_at`, `updated_at`
- `rep_id`: FK to `sales_reps.id` (who sent, denormalized from emails table)

**`emails`** (sent outreach emails):
- `id`: CUID
- `from`, `to`, `subject`, `html`, `text`
- `resendId`: Resend's message ID (unique)
- `messageId`: RFC 2822 Message-ID header
- `threadId`, `inReplyTo`, `references`: threading
- `rep_id`: FK to `sales_reps.id` (who sent)
- `status`: "queued" | "sent" | "delivered" | "opened" | "clicked" | "bounced" | "complained"
- `createdAt`, `updatedAt`

**`brief_lookups`** (WeChat conversions):
- `id`: UUID
- `email`: researcher's email address
- `marked_by_rep_id`: FK to `sales_reps.id` (who recorded conversion)
- `marked_at`: timestamp
- `lead_id`: optional FK to `pipeline_leads.id`

**`sales_reps`** (team):
- `id`: SERIAL PK
- `name`: display name (Leo, Chenyu, Ethan)
- `sender_email`: email address for sending (leo@compute.miracleplus.com)
- `sender_name`: name shown in From: header
- `wechat_id`: rep's WeChat account for sharing
- `role`: "admin", "senior", or "sales"
- `active`: boolean

**`WebhookEvent`** (canonical history):
- `id`: CUID
- `emailId`: FK to `emails.id`
- `type`: "email.sent", "email.delivered", "email.opened", "email.clicked", etc.
- `payload`: full JSON from Resend
- `createdAt`

**`prompt_drift_patterns`** (detected edits):
- `id`: UUID
- `detected_at`, `status` ("pending", "accepted", "ignored")
- `category`: type of change
- `ai_phrase`, `sales_phrase`: examples
- `occurrence_count`
- `example_lead_ids`: references for review

**`discovery_leads`** (Hugging Face, GitHub, Product Hunt):
- Parallel to `pipeline_leads`
- `source`: "hf", "ph", or "github"
- Similar enrichment columns (name, email, company, bio, school tier)

**`helper_conversations`** (bot history):
- `id`: UUID
- `rep_id`: FK to `sales_reps.id`
- `started_at`
- Related `helper_messages` table (turn-by-turn chat)

### 9.2 Key Design Decisions

**`emails.status` as Latest-Event-Wins**:
- Resend webhooks come out of order sometimes
- `emails.status` is updated to the **latest event type received** (by timestamp)
- But `WebhookEvent` table is **canonical history** (immutable appends)
- Query: "how many leads converted?" = "how many have an email.clicked + brief_lookup in past 7 days"

**`draft_original_html` Preservation**:
- When rep sends an email, before saving the edited version, copy the original draft to `draft_original_html`
- Enables diff for admin review and drift mining
- Never overwritten; historical record of what AI suggested

**`marked_by_rep_id` vs. `assigned_rep_id`**:
- Assignment is routing policy (set once at discovery)
- Marking is action (set when rep confirms conversion)
- Deliberately asymmetric: allows team collaboration, credits the closer

**School Tier Denormalization**:
- Computed from email domain at scan time, stored in lead row
- Could be a lookup join, but:
  - Tier data rarely changes
  - 100+ lookups per cron run would be slow
  - Simplifies queries and scoring

---

## 10. Key File Structure

### Application Routes
- `/` — Dashboard (login check, redirects to `/pipeline` if authenticated)
- `/login` — Auth entry point
- `/pipeline` — Main lead stream (Browse, Review, Bulk modes)
- `/emails` — Sent emails list + brief panel for WeChat conversions
- `/inbox` — Inbound email replies
- `/scorer` — Conversion model + analysis
- `/drift` — Admin drift pattern review
- `/brief` — Brief lookup testing page
- `/logs` — Event audit log
- `/settings` — Admin rep CRUD

### API Routes
- `/api/auth/*` — Login/logout
- `/api/cron` — Daily trigger
- `/api/pipeline/*` — Lead CRUD, send, batch operations
- `/api/emails/*` — Email CRUD, sync
- `/api/brief/*` — Brief lookup, WeChat mark
- `/api/scorer/*` — Model training, scoring, analysis
- `/api/drift/*` — Pattern mining, review
- `/api/help/*` — Helper bot (ask, execute tools, conversations)
- `/api/inbound/*` — Resend webhooks, inbound email parsing
- `/api/import` — Python scraper import

### Key Libraries
- `/src/lib/auth.ts` — JWT signing/verification
- `/src/lib/assignment.ts` — Tier classification, rep routing
- `/src/lib/scanner.ts` — arXiv paper parsing
- `/src/lib/semantic-scholar.ts` — Author enrichment API
- `/src/lib/email-generator.ts` — Draft creation
- `/src/lib/logistic.ts` — Conversion scoring model
- `/src/lib/helper-tools.ts` — Bot tool catalog
- `/src/lib/helper-read-tools.ts` — Bot read tool implementations
- `/src/lib/drift.ts` — Pattern detection utilities
- `/src/lib/llm-proxy.ts` — Anthropic/Gemini API wrapper
- `/src/lib/db.ts` — Supabase client
- `/src/middleware.ts` — Route protection

### Database
- PostgreSQL hosted on Supabase
- Prisma (though many tables defined via migrations, not schema.prisma)
- Migrations in `/migrations/*.sql` (20+ numbered files, idempotent)

---

## 11. Deployment & Configuration

### Environment Variables
- `DATABASE_URL` — Postgres connection string
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — API access
- `RESEND_API_KEY` — Sending emails
- `INBOUND_SECRET` — Webhook authentication
- `CRON_SECRET` — Cron job authentication
- `PIPELINE_IMPORT_KEY` — Python scraper authentication
- Claude/Gemini API keys for LLM calls

### Production
- Deployed to Vercel (Next.js default)
- Cron trigger via Vercel (or third-party scheduler)
- Database: Supabase PostgreSQL
- Email delivery: Resend
- Serverless functions with 300s max duration (cron job)

### Local Development
```bash
npm run dev           # Start dev server on localhost:3000
npm run db:migrate   # Apply migrations
npm run db:push      # Sync Prisma to DB (if using Prisma)
```

---

## 12. Example User Journey

**Monday 6:15 AM UTC** (after cron):
- 85 new arXiv papers scanned
- 32 matched Qiji directions (4D, robotics, world models)
- Enriched with h-index (Semantic Scholar)
- Classified: 8 strong (Leo), 12 normal domestic (Chenyu), 12 normal overseas (Ethan)
- Drafts generated; status = "ready"

**Monday 9:30 AM** (Leo logs in):
- Opens `/pipeline`, sees his 8 strong leads
- Filters to "ready" status
- Scans first paper: "Diffusion-based 3D Asset Generation"
- Draft looks good: subject = "Qiji Compute: Free GPU for Your 3D Generative Research"
- Clicks Send → `/api/send` fires → Email created, sent via Resend → status = "sent"
- Resend immediately fires `email.sent` webhook → WebhookEvent created

**Tuesday 2 PM** (researcher replies via WeChat):
- Leo gets a DM: "这个计划怎么样?" (what's this program like?)
- Leo replies, explains grant, arranges next steps
- Leo goes back to `/emails` page, clicks the researcher's email
- Right sidebar Brief panel loads
- Leo clicks "Added on WeChat" button
- → `brief_lookups` row created with `marked_by_rep_id = 1` (Leo)
- Leo's conversion counter goes up by 1

**Wednesday 7 AM** (cron runs again):
- Drift mine runs on Tuesday's edits (if any)
- Detected pattern: "Leo always changes 'collaboration' to 'partnership'"
- Pattern stored as pending → admin reviews at `/drift` tomorrow

**Wednesday morning** (admin checks `/scorer`):
- New model trained overnight (30 new signals accumulated)
- AUC improved from 0.78 → 0.81
- Feature importance: school_tier > h_index > compute_confidence
- Calibration chart shows score = 0.7 → 68% actual conversion rate (well calibrated)

---

## Conclusion

Qiji Pipeline is an end-to-end sales enablement system built for speed and learning. It combines:
- **Automated discovery** (arXiv scanning, enrichment, classification)
- **Intelligent routing** (tier + geography → rep)
- **Human-in-the-loop drafting** (AI generates, rep edits, system learns)
- **Conversion tracking** (WeChat attribution, not just lead ownership)
- **Continuous optimization** (drift mining, scoring models, pattern detection)

The system is designed for a small, high-velocity sales team to move from paper publication to sent email within hours, and to track conversions with enough signal to continuously improve the outreach model.
