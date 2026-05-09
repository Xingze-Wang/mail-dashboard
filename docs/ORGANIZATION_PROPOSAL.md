# Where everything lives — and where it should

Draft 2026-05-09. Map of current state + a concrete reorg proposal.

## What we have today

**33 pages, 10 cron routes, 67 migrations.** The surface area has grown faster than the navigation. Three subsystems with real overlap:

### A. Daily-ops loop (works fine, well-organized)

Where reps live. Don't touch this.

```
/overview           → top-of-day summary (counts, alerts)
/pipeline           → leads to send / review (the core sales surface)
  /pipeline/<id>    → lead detail
/emails             → sent / received / threads
/inbox              → recipient replies (auto-routed)
/brief              → per-recipient research brief (sales prep)
/scorer             → lead-tier classifier output
  /scorer/calibration   → tune the model
  /scorer/demand        → demand-side signals
/drift              → catch broken / changed signals
```

This is the Pipeline → Email → Reply → WeChat funnel, exactly mirroring how a rep works through the day. Stable and not in scope for reorg.

### B. Template ecosystem (sprawled — needs consolidation)

The new system from this session has spawned multiple URLs that aren't obviously related:

```
/templates                → Library tab (new email_templates) + Editor (legacy templates table) + Performance
/templates/bench          → visual diff: leads × templates grid
/templates/<id>/inspect   → deep dive on one template, multi-lead render with parts breakdown
/admin/template-insights  → AI-vs-human rating gaps
/admin/inbox              → Leon-flagged actions (bigger than templates but contains template proposals)
```

**Problem**: 5 different URLs for what's morally one thing — "the template lifecycle." Admin has to know which one for what.

**Confusion sources**:
- `/templates/bench` vs `/bench` (lead scorer benchmark) vs `/congress/bench` (whatever that is) — three different benches
- `/templates` Editor tab still drives the LEGACY `templates` table; Library tab drives `email_templates` (new system). They look identical.
- `/admin/template-insights` is a single page that should logically be a tab on `/templates`

### C. Intelligence / congress (also sprawled)

Multi-agent reasoning and analytics:

```
/congress                       → Weekly congress overview (control room)
/congress/about                 → docs page
/congress/architecture          → architecture doc
/congress/bench                 → ???
/congress/discuss               → ???
/congress/editor                → ???
/congress/history               → past runs
/congress/proposals/<id>        → individual proposal detail
/congress/timeline              → timeline view
/analysis                       → org-level analytics (segment funnels)
  /analysis/cut/<dim>           → drill on one dimension
  /analysis/direction           → research-direction analytics
  /analysis/geo                 → geo analytics
  /analysis/raw                 → raw data view
```

10+ pages across two URL families (`/congress/*` and `/analysis/*`). What's in /congress/bench vs /bench? Probably nothing rep-facing in either.

## Proposal

Three principles:

1. **One navigable entry per top-level concept.** No more "where do I look — /templates or /admin/template-insights?"
2. **Tabs inside, not separate routes.** Detail flows stay as their own routes (e.g., `/templates/<id>/inspect`), but the cross-cutting analytics live as tabs.
3. **Sidebar matches admin's mental model**, not our backend taxonomy.

### Sidebar (final)

```
═══ DAILY OPS (sales) ═══
Overview                         (= /overview, the morning view)
Pipeline                         (= /pipeline)
Emails                           (= /emails — sent + received tabs)
Brief                            (= /brief)

═══ TEMPLATES & EXPERIMENTS (admin) ═══
Templates                        (= /templates, with sub-tabs:)
  ├─ Library                       — list of all email_templates
  ├─ Bench                         — visual leads × templates grid (was /templates/bench)
  ├─ Insights                      — AI vs human rating gaps (was /admin/template-insights)
  └─ Editor (legacy)               — old singular-templates editor

═══ INTELLIGENCE (admin) ═══
Congress                         (= /congress, with sub-tabs:)
  ├─ Hypotheses                    — in-flight hypotheses + outcomes (already there)
  ├─ Proposals                     — pending decisions queue
  ├─ History                       — past runs
  └─ Architecture                  — docs (out of the way)

Insights                         (= /analysis, with sub-tabs:)
  ├─ Funnel                        — geo / school / direction breakdown
  ├─ Drift                         — was /drift, now a tab
  └─ Scorer                        — model calibration

Admin inbox                      (= /admin/inbox, kept separate — it's a notification center, not a section)
```

That's **8 sidebar items** instead of 10+. Daily-ops on top (where reps spend their time), admin-only sections below.

### URL changes

The visible-to-bookmarks routes that change:

| Old | New | Reason |
|-----|-----|--------|
| `/admin/template-insights` | `/templates?tab=insights` | Same data; better discoverability |
| `/templates/bench` | `/templates?tab=bench` | Same — bench IS a template view |
| `/drift` | `/analysis?tab=drift` | Drift is just one analysis cut |
| `/scorer` | `/analysis?tab=scorer` | Same — scorer health is analytics |
| `/bench` (root) | DELETE or redirect to `/scorer` | Confusing duplicate |
| `/congress/bench`, `/congress/discuss`, `/congress/editor` | check what they do, likely deletable | Probably abandoned UI experiments |

### What stays as own route

- `/templates/<id>/inspect` — detail flow, deep enough to deserve its own URL
- `/congress/proposals/<id>` — same
- `/pipeline/<id>` — same
- `/admin/inbox` — notification center; its own URL is correct

## What this proposal does NOT change

- Database schema — no migrations
- API routes — `/api/templates/...`, `/api/admin/...`, `/api/cron/...` all stay
- Cron schedules
- Sales-side daily flow (Overview / Pipeline / Emails / Brief) — untouched

## Cost of doing it

- Tab consolidation: ~1 day, mostly moving JSX into shared layouts
- Old URL redirects: ~30 min (simple `redirect()` in Next.js page files)
- Sidebar update: ~30 min, single component
- Reading + deleting abandoned `/congress/*` routes: ~1 hr

Total: ~1.5 days of work. No data migration, no risk to production sends.

## Cost of NOT doing it

- Admin asks "where's the template thing" and gets pointed at the wrong URL
- New rep onboards thinking they need to learn 33 pages
- Future features pile onto existing sprawl, making each new addition harder
- "I'm still not seeing the change" — exactly the moment this morning that prompted this doc

## Recommendation

Do the consolidation in a single PR. The cost is low, the readability gain is high, and we already have all the underlying APIs working. The sidebar and tab moves are pure UX layer changes.

If you say yes, I do it as the next commit. If you want any of the proposed structure tweaked first, tell me what and I revise this doc before touching code.
