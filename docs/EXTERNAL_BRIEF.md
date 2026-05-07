# Qiji Pipeline — External Brief

A single-file digest of this codebase, current state, and open design question. Paste this into another LLM and ask it to opine.

---

## The product, in one paragraph

Qiji Pipeline is an internal sales tool for **奇绩算力 (Qiji Compute)**, a free GPU grant program for Chinese AI researchers. It scans arXiv nightly (via a Python sibling repo at `~/Desktop/Email/resend0412.py`), enriches each paper's authors with Semantic Scholar data, classifies leads as "strong" or "normal," routes them to one of three sales reps (Leo / Yujie / Ethan) by tier + email-domain geography, generates personalized outreach emails through Resend, and tracks WeChat conversions. Stack: Next.js 16 + React 19 on Vercel, Supabase Postgres, Anthropic + Google for LLM, Lark (Feishu) bot interface for sales reps. ~5 sales reps, ~887 leads in DB, ~1000 emails sent, ~4286 person rows. Deployed at `qiji-pipeline.vercel.app`.

---

## The full data flow (one cron tick)

1. **6 AM UTC, daily**: `GET /api/cron` (Bearer-auth via `CRON_SECRET`) runs:
   - Sync from Resend webhooks (catches up `webhook_events`, updates `emails.status`)
   - Scan arXiv (300 papers max, 40s budget) — categories `cs.LG, cs.AI, cs.CV, cs.CL, cs.RO, stat.ML`
   - For each paper: Chinese-surname pre-filter → PDF download → email extraction → Gemini classifier (compute-need + research direction) → S2 enrichment (h-index, citations) → tier (`strong` if citation > 2000 OR school_tier ≤ 2, else `normal`) → assignment (strong→Leo, normal+overseas→Ethan, normal+domestic→Yujie)
   - Write to `pipeline_leads` table with `status='ready'` and a draft email pre-generated
   - **Drift mining** — analyze last 30 days of `pipeline_leads` where `draft_edit_distance > 0` (rep edited the AI draft), extract recurring patterns via LLM, write to `prompt_drift_patterns` with `status='pending'`
   - **Emit retrain signals** — count new conversions; if ≥ threshold, create a `retrain_proposals` row

2. **Sales rep workflow** (manual, on `/pipeline`):
   - Browse incoming leads, filter by status/tier
   - Click into Review mode, see paper + draft side by side
   - Send (uses `loadEffectiveTemplate` + `assembleDraft` from `src/lib/template-assembler.ts`)
   - Or skip / flag / redraft via the helper bot

3. **Conversion tracking**:
   - WeChat add → rep clicks "Added on WeChat" → row in `brief_lookups` with `marked_by_rep_id`
   - This is the canonical conversion event. Scorer trains on it.

4. **The helper bot ("老师傅")**:
   - Available on web at `/help` panel and via Lark bot
   - 14 read tools (auto-execute, bounded server-side: list_leads, get_lead, get_my_stats, diagnose_metric_drop, etc.)
   - 12 action tools (require user-confirm card on web; only `remember_about_rep` auto-executes on Lark today)
   - Persists conversation history to `helper_messages` (web) or `lark_messages` (Lark)
   - Cross-surface: when user says "之前/上次", web history pulled into Lark prompt and vice versa
   - Backed by Claude Opus 4.7 (primary) / Gemini 3 Flash (fallback for cost)

---

## The "data analyst" → "congress" question (the actual ask)

The system has multiple feedback loops that *detect* things but don't fully *act* on them. Three exist, only the first is wired end-to-end.

### Loop 1: Conversion scorer (works)
- Logistic regression over ~15 features (h-index, school_tier, compute_confidence, direction-CVR, etc.)
- Trained on positive labels (`brief_lookups.marked_by_rep_id` set) and negative labels (sent ≥14 days ago, no brief lookup)
- F1 ~0.88
- Surfaced in `/scorer` page: feature importances, calibration curve, per-direction breakdown
- **But**: model results don't auto-feed routing decisions. Scoring shows up in admin UI; routing rules are still hardcoded in `src/lib/assignment.ts`.

### Loop 2: Drift mining (detection works, application doesn't)
- Nightly LLM compares `draft_original_html` (AI version) vs `draft_html` (rep's version) for last 30 days
- Extracts recurring patterns (e.g., "AI says 'collaborate', rep changes to 'partner'")
- Writes to `prompt_drift_patterns` with `status='pending'`
- **Current state in production DB right now**: **6 patterns detected, all `pending`. None `accepted`, none `ignored`. Patterns are concrete:**
  - x3: "用X方案解决Y问题的方案很有启发" → "X框架/方法很有启发" (rep prefers shorter framing)
  - x3: "欢迎 申请 或加我微信" → "欢迎申请或加我微信" (rep removes spaces around 申请)
  - x3: "用X解决Y问题的方案很有启发" → "其中的X框架很有启发"
  - x3: "奇绩算力计划目前正开放新一轮的申请" → "申请 with spaces as hyperlink anchor" (rep formats applies-link)
  - x2: "用X框架解决Y问题的方案很有启发" → "用X框架很有启发"
- **The problem**: the `/drift` page exists for admin review but no admin has clicked Accept/Ignore, so patterns just pile up. Even when accepted, there's no mechanism to fold them into next day's drafts — `email-generator.ts` doesn't read accepted patterns.

### Loop 3: Template performance (data collected, no decisions made)
- `emails.template_id` stamped at send time; `email_template_versions` snapshots template state at every edit; `email_template_overrides` allows segment-conditional variants by `geo` (cn/edu/other) and `school_tier`
- **Current state**: **1 template active (`global`), 0 per-rep variants, 0 segment overrides, 1000 emails sent through it (26.5% open+click rate)**
- The infrastructure for A/B'ing variants exists; nobody has created variants. There's no auto-promotion of better-performing variants.

---

## The "congress" ask, framed

The user's mental model: there's a "data analyst" (the drift miner + scorer) producing findings. Findings should go to a "congress" that decides what to do — accept/reject patterns, promote template variants, retrain models, even adjust assignment rules. Right now that congress doesn't exist as code; humans are the implicit congress and they're not showing up.

The question is **what should the congress consist of?**

Possible answers (LLM should weigh these and propose alternatives):

1. **Auto-apply everything above a threshold** — e.g., drift patterns with `occurrence_count ≥ 5` get auto-accepted and folded into prompts, retrain proposals with projected_AUC delta > 0.05 get auto-applied. Risk: silently drifting prompts that nobody reviewed.
2. **Daily admin nudge** — admin gets a Lark bot DM each morning summarizing pending decisions: "5 drift patterns waiting (3 high-confidence), 1 retrain proposal (+0.04 AUC), 0 template variants to evaluate." Force a human to spend 5 min triaging. Risk: admin still doesn't show up.
3. **Per-rep self-governance** — each rep sees their own drift patterns ("you keep changing X to Y") and can promote them to their per-rep template via a one-click action. Decentralizes review. Risk: per-rep templates fragment quality.
4. **A/B framework with stop-loss** — every accepted change becomes an A/B test on the next 50 sends; the worse-performing arm auto-rolls back. Hardest to build but most defensible.
5. **Some combination** — e.g., admin nudge for accept/reject + auto-apply once accepted + A/B framework for big swings (template-level) but not small ones (single phrase).

---

## Hard constraints when designing this

- **Sales team is 5 people.** Can't build a system that needs a dedicated PM to operate.
- **Conversion is sparse.** WeChat-add conversion rate is ~2-7% per direction. Statistical significance for A/B testing requires hundreds of sends per arm.
- **Sales is fluid.** A rep changes a phrase because they're talking to a specific researcher today, not because the phrase is universally bad. Can't auto-apply every edit.
- **Drift loop has been running for ~30 days.** 6 patterns detected, all unreviewed. The "humans-as-congress" baseline produces zero throughput. New design must beat that.
- **Trust before autonomy.** The helper bot's design philosophy is "old master mentoring junior" — surface evidence, propose, don't act unilaterally. The congress should match this — propose actions, require human ratification at first, build trust before auto-applying.
- **Memory is per-rep AND org-wide.** `helper_learnings` table has `scope_rep_id` (NULL = org-wide). Congress decisions should be scoped — some apply org-wide, some per-rep.
- **Reversibility matters.** Migration 033 captures `email_template_versions` snapshots before every update. Any congress decision that mutates templates should respect this so rollback is one click.

---

## The repo's current bottleneck (be specific)

We are NOT bottlenecked on:
- Detection (drift miner works, scorer works, template_id stamping works)
- UI surface (`/drift` page exists, `/scorer` page exists, `/templates` page exists)
- Schema (every relevant table is there with the right columns)

We ARE bottlenecked on:
- **Closing the loop** — turning detected patterns into applied changes
- **Removing humans from low-stakes decisions** — admins won't click 6 Accept buttons; they will accept 1 weekly summary
- **Statistical guardrails** — without an A/B framework or stop-loss, "auto-apply" is scary

---

## What the external AI should produce

A concrete proposal for "congress design" — what should the loop look like? Specifically:

1. **For each of the three loops above** (scorer, drift, templates), what's the right cadence + decision authority + rollback story?
2. **What's the minimum viable congress** — what's the single thing we should build first to get >0 throughput on accepted decisions?
3. **What guardrails prevent the system from quietly drifting bad?** (e.g., a rep accepts a drift pattern that turns out to lower conversion — how does the system notice and undo?)
4. **What should NOT be automated** (i.e., what stays human-only forever, even if it's tedious)?

Output should be opinionated. Skip "it depends" — the constraints above should narrow it down. If the right answer is "you don't need a congress, you need to fire the existing system and build X," say that.
