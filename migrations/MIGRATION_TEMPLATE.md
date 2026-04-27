# Migration template

Every new migration in `migrations/` must answer the four questions
below before merging. The point isn't paperwork — every silent data
incident on this codebase has shipped because at least one of these
went unanswered. Three are about *new rows*; the fourth is about
*old rows*, which is the one we miss most often.

Copy this header into the top of every new `migrations/NNN-foo.sql` as
SQL comments before writing any DDL.

```sql
-- migrations/026-foo.sql
--
-- 1. SCHEMA CHANGE
-- What columns / tables / indexes / views does this add or alter?
-- One short paragraph. List the column types if non-obvious.
--
-- 2. WHO WRITES THIS?
-- Which code path will populate the new column on NEW rows going
-- forward? File:line is fine. If multiple writers, list them all.
-- If "no one writes it yet" — say so, and explain when they will.
--
-- 3. WHO READS THIS?
-- Which code path will read it? Be honest about whether it's a
-- one-shot script, a UI surface, or both.
--
-- 4. BACKFILL FOR OLD ROWS  ← the one we always forget
-- For rows that exist in the table TODAY (before this migration),
-- how does the new column get populated? Pick one:
--   (a) one-shot UPDATE inline below — preferred when cheap
--   (b) backfill route at /api/<area>/backfill-<thing> — if the
--       value needs an external lookup (Resend, S2, etc.)
--   (c) "intentionally NULL forever for legacy rows" — must explain
--       why old NULLs won't break the consumer in (3)
--   (d) "not applicable — no old rows can have this concept" — must
--       explain why (e.g., new table, or the concept didn't exist before)
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4
```

## Why each question matters

**(1)** is the obvious one. Mostly here so reviewers can scan
without opening the SQL.

**(2)** is what catches "we added a column for `wechat_at` but the
brief panel never writes it" — easy to miss because the SQL is
syntactically fine, the bug is structural.

**(3)** is the fairness check on (4). If nothing reads the column,
old NULL rows don't matter — but you should say so explicitly so
the next reviewer doesn't ask. If something reads it, (4) becomes
load-bearing.

**(4)** is the one we always forget. Past incidents:
- 1100+ legacy emails with no `text`/`html` body (search returned 0)
- inbound rows with no `rep_id` (replies hidden from new reps)
- WeChat marks pre-attribution (counted org-wide but not per-rep)

Each of those was a column added without a backfill plan. Each was
invisible until a user noticed.

## Don't merge until

- [ ] All four questions answered in the SQL header
- [ ] If (4) is `(b)` (backfill route), the route exists in this PR
      or a linked one, and a draft GH issue tracks running it
- [ ] If a non-trivial column was renamed, ran `tsc --noEmit` to
      confirm no callers reference the old name
- [ ] `pnpm lint:integrity` passes (catches the `eq("status",
      "<event>")` antipattern from Tier 2)
