-- ═══════════════════════════════════════════════════════════════════
-- Migration 013: Foreign keys for helper tables
--
-- Migrations 006 (helper_conversations/helper_messages) and 007
-- (helper_rep_state) declared rep_id as a plain INTEGER with no FK
-- to sales_reps. Deleting a rep row leaves orphans in both tables —
-- helper_rep_state becomes unreachable (PK is rep_id, but sales_reps
-- row gone) and helper_conversations become invisible to non-admin
-- (filter is rep_id == session.repId).
--
-- Adds FKs with ON DELETE CASCADE so rep deletion cleans up cleanly.
-- Using DO blocks + IF NOT EXISTS-style checks to stay idempotent
-- across re-runs; Postgres doesn't support "ADD CONSTRAINT IF NOT
-- EXISTS" directly before 17.
-- ═══════════════════════════════════════════════════════════════════

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'fk_helper_rep_state_sales_reps'
      and table_name = 'helper_rep_state'
  ) then
    alter table helper_rep_state
      add constraint fk_helper_rep_state_sales_reps
      foreign key (rep_id) references sales_reps(id) on delete cascade;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'fk_helper_conversations_sales_reps'
      and table_name = 'helper_conversations'
  ) then
    alter table helper_conversations
      add constraint fk_helper_conversations_sales_reps
      foreign key (rep_id) references sales_reps(id) on delete cascade;
  end if;
end $$;
