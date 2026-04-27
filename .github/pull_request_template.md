<!--
Quick PR — delete sections that don't apply.
The "data integrity" section is REQUIRED if this PR touches a migration,
adds a new DB column, or adds a new read endpoint. See
docs/DATA_INTEGRITY_PLAN.md for context.
-->

## What

<!-- 1-3 sentences. The "why" matters more than the "what" — the diff
shows the what. -->

## Test plan

- [ ]
- [ ]

## Data integrity (REQUIRED if migration / new column / new read endpoint)

<!-- Skip if N/A. -->

**If this PR adds or alters a column:**
- Who writes it on NEW rows going forward?
- Who reads it?
- **How do rows older than this PR get the column populated?**
  - one-shot SQL UPDATE in the migration
  - backfill route at `/api/.../backfill-...`
  - intentionally NULL forever (explain why nothing breaks)
  - new table (no old rows exist)

**If this PR adds a new list/read endpoint:**
- Does the response include `_source` and `truncated` from `lib/list-envelope.ts`?
- If the endpoint can hit a row cap, does the UI consume `truncated` and warn the user?

**If this PR queries `emails.status`:**
- Are you reading "current state for display" (inbox UI) or "did X
  ever happen" (analytics)? The latter must use the `email_history`
  view (`was_clicked` / `was_bounced`), not `.eq("status", ...)`.
  See Tier 2 of the integrity plan. `pnpm lint:integrity` catches this.

## Migration checklist (if `migrations/` is touched)

- [ ] Migration header follows `migrations/MIGRATION_TEMPLATE.md`
- [ ] Backfill plan exists for old rows (or N/A explained)
- [ ] `pnpm lint:integrity` passes
- [ ] Applied to prod Supabase via `scripts/apply-NNN.mjs` or noted in this PR
