# Template / Prompt Experimentation — Design Doc

Draft for review, 2026-04-18. No code changes yet.

---

## 1. What "template" means here

Four candidates: **(a)** static HTML scaffold; **(b)** the Gemini prompt that writes the personalized intro; **(c)** a whole-email prompt; **(d)** hybrid of (a)+(b).

**Recommend (b) for v1.** The intro is the highest-variance, highest-leverage chunk and is already isolated as a swappable Gemini call in `email-generator.ts`. HTML scaffold, third paragraph and CTA are stable; lifting them into a templating system balloons surface area (HTML editor, sanitization, variable extraction from hardcoded Chinese strings) without proportional lift. Add (a) in M3+ once the loop is proven.

---

## 2. Data model

The current `templates` table (`{name, subject, html, text}`) is hacked into a prompt store via the convention `name="pipeline_intro_prompt"` and `html=prompt body`. Replace with explicit columns.

```sql
-- 003-template-experiments.sql

ALTER TABLE templates ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'html_template';
  -- 'html_template' | 'prompt_template'
ALTER TABLE templates ADD COLUMN IF NOT EXISTS prompt_text TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS variables JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS parent_template_id TEXT REFERENCES templates(id);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_templates_kind ON templates(kind) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS experiments (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name           TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft|running|paused|complete
  variants       JSONB NOT NULL,                 -- [{template_id, allocation_pct, label}]
  target_segment JSONB NOT NULL DEFAULT '{}'::jsonb,
                  -- {tier, overseas, rep_id, category}
  primary_metric TEXT NOT NULL DEFAULT 'reply_rate',
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  winner_template_id TEXT REFERENCES templates(id),
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);

ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS template_id    TEXT REFERENCES templates(id);
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS experiment_id  TEXT REFERENCES experiments(id);
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS variant_label  TEXT;  -- denormalized
CREATE INDEX IF NOT EXISTS idx_leads_template   ON pipeline_leads(template_id);
CREATE INDEX IF NOT EXISTS idx_leads_experiment ON pipeline_leads(experiment_id);
```

Stats: join `pipeline_leads` (via `template_id`/`experiment_id`) → `emails` (via `author_email`+`sent_at`, then `thread_id`) → `inbound_emails` (replies) → `brief_lookups` (WeChat). Opens/clicks come from `webhook_events` (Resend already maps `email.opened`/`email.clicked`, see `src/app/api/webhook/route.ts:6`).

---

## 3. Variant assignment

Options: hash-based (`hash(lead_id) % N`, deterministic, stateless), round-robin (needs counter), multi-armed bandit (Thompson, optimal regret), manual.

**Recommend hash-based for M1–M2, bandit for M3.** Determinism matters: a regenerate-draft action must yield the same variant. Hash on `lead_id` against `variants[]` weighted by `allocation_pct`. Round-robin is overkill at our scale (~tens of sends/day) and adds a synchronized counter.

---

## 4. Statistics

Per variant: **reply_rate**, **wechat_rate**, **open_rate** (M4), each with **Wilson 95% CI**. Show "low confidence" badge when any variant has `n<50`. Disable "Declare winner" until all variants have `n≥50` AND leader's lower CI bound > runner-up's upper CI bound.

**Bayesian (M3):** maintain `Beta(1+replies, 1+sent-replies)` per variant; `P(variant_i is best)` via 10k Monte Carlo draws. Drives the bandit and gives a more intuitive headline.

Reply rate is the **leading indicator** (~10x WeChat volume) — default `primary_metric`. WeChat is the validation metric — display alongside.

---

## 5. UI / UX

### 5a. Template editor — extend `/templates`

Add kind-aware tabs and a real-lead test render.

```
┌─ /templates ────────────────────────────────────────────┐
│ [ Prompts (3) | HTML Layouts (1) ]            [+ New ]  │
├─────────────────────────────────────────────────────────┤
│ ▸ intro_v1_default        active • used by 2 exps       │
│ ▸ intro_v2_shorter        active • used by 1 exp        │
│ ▸ intro_v3_research_lead  draft                         │
│ ▸ intro_v0_legacy         archived                      │
└─────────────────────────────────────────────────────────┘
```

Editor (prompt kind):

```
Name / Description
Variables (auto-detected from {{...}}):
  {{title}} {{abstract}} {{author_name}} {{matched_directions}}
Prompt: <textarea>
Test render:  [ pull random recent lead ▾ ] [ Run ]
  Lead: Wang et al., "LatentUM..." (2 days ago)
  Rendered prompt: <expandable>
  Gemini output:   "最近在跟踪多模态推理的研究时，..."
  Final email preview: <iframe>
[ Cancel ]   [ Save as new version ]   [ Save ]
```

**Versioning:** if template is referenced by a `running` experiment, **fork** (new row, `parent_template_id` set). Otherwise mutate. Protects in-flight stats.

Test render upgrade over current `templates/test`: pull a real recent lead from `pipeline_leads` (not the hardcoded `SAMPLE_PAPER`), render the full email.

### 5b. Experiments — new page `/experiments`

```
┌─ Experiments ────────────────────────────────[+ New]────┐
│ ● running   intro_v1 vs v2     normal/CN  3d  124 sends │
│ ● running   subject_line_test  all        7d  312 sends │
│ ◐ paused    long_intro         strong/US  ago  44 sends │
│ ✓ complete  v0_vs_v1           — winner: v1             │
└─────────────────────────────────────────────────────────┘
```

Wizard: (1) name + primary metric; (2) pick ≥2 variants (auto-label A/B/C); (3) target segment (reuse pipeline-page filter components); (4) allocation sliders summing to 100; (5) confirm with projected days-to-significance based on current daily send rate to that segment.

Detail view:

```
intro_v1 vs v2 (running, day 3) — segment: tier=normal, overseas=false
              sends  opens  replies  wechat   reply%
A v1_default   62    —      4        1        6.5 ±3.1
B v2_shorter   62    —      9        3       14.5 ±4.4

reply rate (95% CI):
A ▓▓░░░░ 6.5%  ├──┤
B ▓▓▓▓▓▓ 14.5%      ├────┤
⚠ CIs overlap — keep running (need N≥100/variant)

[ Pause ]  [ Edit allocation ]  [ Declare winner: B ▾ ]
```

"Declare winner" sets `winner_template_id`, archives losers (optional), and (M3) writes to `system_config` so the segment defaults to the winner.

### 5c. Lead row (Pipeline page)

In the expanded panel:

```
Template: intro_v2_shorter (exp: intro_v1_vs_v2, variant B)
[ Override ▾ ]   ← non-archived prompts; regenerates draft
```

Override re-runs `generateDraft`, updates `template_id`, clears `experiment_id`. Toast: "Excluded from experiment stats."

### 5d. Channels / Sales tabs

Add "Performance by Template" sub-section above existing tables:

```
Template               sends  reply%  wechat%
intro_v1_default       412    7.2%    1.8%
intro_v2_shorter       180   12.3%    2.6%   ← winning
intro_v3_research_lead  65    9.1%    1.5%
```

Add a `template` filter dropdown to the existing per-rep / per-tier breakdowns.

---

## 6. Phasing

| M | User-visible | Files | Cx |
|---|---|---|---|
| **M1** Data model + manual selection | Edit prompts as first-class entities; pick template per lead before send. No experiments yet. | `migrations/003-template-experiments.sql`; rewrite `src/app/api/templates/route.ts` (handle `kind`, `prompt_text`, fork-on-edit); new `src/app/api/templates/preview/route.ts` (real-lead render); update `src/app/templates/page.tsx` (kind tabs, var hints); `src/lib/email-generator.ts` accepts `templateId`; `src/app/api/pipeline/send/route.ts` + `batch-send` write `template_id`; LeadRow override in `src/app/pipeline/LeadRow.tsx`. | M |
| **M2** Experiment runner + basic stats | Create A/B experiments, hash-based allocation, live reply%/wechat% with Wilson CI. | new `src/app/api/experiments/route.ts` + `[id]/route.ts`; new `src/lib/experiments.ts` (hash assignment, segment match, Wilson); new `src/app/experiments/page.tsx` (list + detail + wizard); hook `pipeline/route.ts` POST and `send`/`batch-send` to call `assignVariant(lead, runningExperiments)` before draft generation. | L |
| **M3** Bandit + auto-promotion | Thompson sampling reallocates traffic; "Declare winner" persists segment default; Bayesian P(best). | extend `src/lib/experiments.ts` (Beta posterior); add `default_template_per_segment` lookup before system fallback; nightly cron refreshes allocations. | M |
| **M4** Open / click tracking | Per-variant open & click rates. | webhook handler already maps the events (`src/app/api/webhook/route.ts:6`); derive per-email status from `webhook_events` (or add a small `email_events` table); surface in experiment detail and Channels view. Verify per-domain "track opens/clicks" toggle in Resend dashboard. | S–M |

---

## 7. Open questions

1. **Reply threading reliability.** `inbound/route.ts` resolves `thread_id` via `in_reply_to → emails.message_id`, but `message_id` on `emails` is only populated via the webhook (`webhook/route.ts:117`). Is it reliably present in production? If not, reply-rate joins are wrong — needs a sample-row check.
2. **Open / click capture.** Webhook already handles `email.opened`/`email.clicked`. Is the **Resend per-domain "track opens/clicks" toggle** on? If yes, M4 is mostly UI. If no, flip it (and add an EU privacy note).
3. **Per-rep vs global experiments.** Each rep's name/WeChat is interpolated, so cross-rep variants confound with rep performance. Proposal: segment may include `rep_id`; cross-rep allowed but flagged.
4. **Primary metric.** Default to reply rate (signal volume) and treat WeChat as the validation metric — confirm?
5. **Auto-promotion.** When significance is hit, auto-default the winner or always require human approval? Recommend human-in-the-loop for v1.
6. **Multi-language.** Prompts are Chinese today; overseas leads currently get the same Chinese email. Tag prompts by language and route by `school_tier`/country, or out of scope for v1?
7. **Archived templates.** Keep historical lead → template links visible (yes, audit), exclude from editor list (yes) — confirm.
8. **Override semantics.** Should an in-pipeline override re-call Gemini end-to-end, or only re-render around the existing intro string? Recommend full regenerate.
