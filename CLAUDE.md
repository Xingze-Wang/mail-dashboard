# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## How to work in this repo

1. Don't assume. Don't hide confusion. Surface tradeoffs.
2. Define success criteria. Loop until verified.

## What this is

**Qiji Pipeline (奇绩算力)** — a Next.js 16 sales-pipeline dashboard for outreach to Chinese AI researchers. Daily cron scans arXiv, enriches authors via Semantic Scholar, routes to one of three sales reps (Leo / Yujie / Ethan) by tier + geography, generates personalized emails through Resend, and tracks WeChat conversions.

For the full product picture, read **`docs/APP_OVERVIEW_EN.md`** before touching anything substantial. Don't re-derive it from code.

## Sibling repo: the Python scanner

`~/Desktop/Email/resend0412.py` is a separate-repo Python scanner. It posts arXiv leads into the dashboard via `POST /api/pipeline/import` (auth: `Bearer $PIPELINE_IMPORT_KEY`). Treat it as a producer that hands raw paper data to this repo. Contract docs:
- `docs/discovery-python-contract.md` — Python ↔ Supabase tables for HF / Product Hunt / GitHub scrapers
- `docs/app-overview.md` § 8 — daily cron heartbeat

## Commands

```bash
npm run dev            # next dev (Turbopack on :3000) — kill existing port first
npm run build          # next build (used by Vercel; type-checks via tsc)
npm run lint           # eslint
npm run lint:integrity # custom: scans for status-equality bugs (see DATA_INTEGRITY_PLAN.md)
npm run lint:fetch     # custom: catches missing res.ok checks (silent-failure family)
npm run integrity      # combined integrity report
npm run db:migrate     # prisma migrate dev
npm run db:push        # prisma db push
```

Long-running scripts:
```bash
npx tsx scripts/lark-bot-worker.ts                # Lark WebSocket worker (long-conn mode)
node scripts/lark-smoke.mjs http://localhost:3000 # End-to-end Lark webhook smoke
node scripts/test-dedup-gate.mjs                  # Replay every contact-history row through dedup
```

## Migrations

Numbered SQL files in `migrations/NNN-*.sql`, applied via matching `scripts/apply-NNN.mjs` runners (each runner POSTs the SQL to Supabase via service key). After adding migration `038-foo.sql`, write `scripts/apply-038.mjs` mirroring the prior runners. The migration file's header comment block (1. SCHEMA CHANGE / 2. WHO WRITES / 3. WHO READS / 4. BACKFILL) is mandatory — see `migrations/MIGRATION_TEMPLATE.md`.

Order matters. Migration 037 is the latest; do not skip numbers, do not edit applied migrations.

## Architecture, the parts a fresh session won't infer

### Auth model is dual-layer
- JWT cookie (`AUTH_COOKIE`, 30-day) sets identity at login
- **Every API request re-reads `sales_reps.role` from DB** via `requireSession()` in `src/lib/auth-helpers.ts`. Do NOT trust the JWT's role field — a demoted user with a valid JWT must lose admin access immediately. The middleware sets `x-rep-role` from the JWT but a comment explicitly warns handlers against trusting it.

### Attribution: actor vs owner (asymmetric, deliberate)
- `pipeline_leads.assigned_rep_id` = OWNER (routing target, set at discovery)
- `emails.actor_rep_id` = WHO PERFORMED THE SEND (audit, set at send time)
- `brief_lookups.marked_by_rep_id` = WHO RECORDED THE WECHAT CONVERSION
- Conversion credit goes to `marked_by_rep_id`, not the lead owner. This is intentional — sales is fluid, the closer gets credit. Never collapse these into one field.

### Helper bot has two transports, one brain
- HTTP webhook: `src/app/api/lark/webhook/route.ts` (URL-verification fast-path, then `after()` for async work)
- Long-connection WebSocket worker: `scripts/lark-bot-worker.ts` (recommended for production — avoids GFW issues with Lark calling Vercel)
- Both transports call the SAME shared processor: `src/lib/lark-agent.ts:processInboundLarkMessage`. **Edit the shared lib, not the transports.**

### Person resolver
`src/lib/person-resolver.ts` exposes `resolvePerson({email, hf_user, github_user, arxiv_author_name})`. Find-or-create with auto-merge via signal-score winner pick. Re-points FK columns (`pipeline_leads.person_id`, `email_contact_history.person_id`) when merging. Migration 035 adds a review queue (`person_enrichment_candidates`) for low-confidence proposals — write to that, not `persons` directly, when confidence < 0.85.

### Templates render at SEND time, not import time
- `src/lib/template-assembler.ts:assembleDraft` is called by `pipeline/send` and `pipeline/batch-send`
- Python (or `draft-queue` worker) writes a baseline draft into `pipeline_leads.draft_html` so the rep sees something on `/pipeline` instantly
- At send time, `loadEffectiveTemplate(rep_id)` checks for an active per-rep template, then global, applies `email_template_overrides` (segment-conditional: `geo` ∈ {cn,edu,other}, `school_tier`)
- `emails.template_id` is stamped at send for `/api/templates/performance` analytics

### Cron is the daily heartbeat
`GET /api/cron` (auth: `Bearer $CRON_SECRET`, cron at `0 6 * * 1-5` in `vercel.json`). Order is significant — Resend sync first, then arXiv scan + assignment, then drift mining, then retrain signals. Each step is `try/catch`'d so one failure doesn't block the next.

### Webhook events are the canonical history
- `emails.status` is "latest event wins" (lossy)
- `webhook_events` rows are append-only and authoritative
- For "how many leads converted" queries, join through `webhook_events`, NOT `emails.status`. Multiple incident SHAs in `docs/DATA_INTEGRITY_PLAN.md` are exactly this bug.

## Conventions that will trip you up

### Next.js 16 specifics (see AGENTS.md too)
- `middleware.ts` is renamed to `proxy.ts` per Next 16 — old name still works but warns
- Use `import { after } from "next/server"` to defer work past response. Anything async after `return NextResponse.json(...)` will be killed otherwise (works in dev, fails in prod)
- `preferredRegion = ["hkg1"]` per-route to pin function region (Lark webhook uses this)
- The webhook handler does dynamic `await import(...)` for heavy modules so cold-start URL-verification stays sub-300ms

### Don't trust paper-side HF extraction
Bench results: HF link in arxiv abstract has 4% recall. The existing `repo-extractor.ts` HF regex matches HTML noise (`huggingface.co/v1/production`). Paper-side HF is dead — use person-side (S2 `homepage`, GitHub commit-author email match → `bench-inverted-lookup.mjs` proved 14% recall, 100% precision-by-definition).

### Discovery-vs-Pipeline tables
- `pipeline_leads` = arXiv-sourced (Python scanner)
- `discovery_leads` = HF / Product Hunt / GitHub (separate Python scrapers, different schema, see `docs/discovery-python-contract.md`)
- Discovery rows can be promoted into `pipeline_leads` via the `/discovery` page

### Long-running operations
Vercel serverless caps at 60s default (300s on Pro). Long ops:
- Backfills (`scripts/backfill-*.mjs`) — run locally against prod DB, not as routes
- Bot agent runs (~30-60s for LLM + tool rounds) — use `after()` to ack first
- Cron's arxiv scan has a 40s budget inside it; tune with the constant in `src/lib/scanner.ts`

## Where to look first

| Task | Read this first |
|---|---|
| Any sales/CRM logic | `docs/sales-expected-behavior.md` |
| Drafting / templates | `docs/template-experiments-design.md`, `src/lib/template-assembler.ts` |
| Adding a helper bot tool | `src/lib/helper-tools.ts` (catalog + system prompt) |
| Any DB query bug or new metric | `docs/DATA_INTEGRITY_PLAN.md` (lessons from past silent-failure incidents) |
| Lark bot changes | `src/lib/lark-agent.ts` (shared brain), then transport |
| Sales rules (tier classification, rep assignment) | `SALES_RULES.md` (overrides anything older) |
| Python scanner contract | `docs/discovery-python-contract.md` |
