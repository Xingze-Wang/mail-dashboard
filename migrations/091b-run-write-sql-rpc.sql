-- Migration 091b: _run_write_sql RPC
--
-- Companion to _run_select_sql (from 088b). Allows INSERT/UPDATE/DELETE
-- against a fixed whitelist of tables, with a hard blacklist that takes
-- precedence. Even if a future migration adds a new "allowed_writes"
-- table name, the blacklist always wins.
--
-- Safety layers (defense in depth):
--   1. Statement must start with INSERT, UPDATE, or DELETE
--   2. No DDL keywords (CREATE/DROP/ALTER/GRANT/REVOKE/TRUNCATE/COPY)
--   3. No multiple statements (no semicolons mid-body)
--   4. Target table extracted via regex, checked against whitelist
--   5. Blacklist (emails / webhook_events / etc) blocks override
--   6. statement_timeout = 10s
--
-- Returns: { ok: true, rows_affected: N } on success, raises exception
-- on validation failure.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION _run_write_sql(
  sql_text text,
  sql_params jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  trimmed text;
  lower_sql text;
  op text;
  target_table text;
  affected int;
  result jsonb;
  p_count int;
  v1 text; v2 text; v3 text; v4 text; v5 text;
  v6 text; v7 text; v8 text; v9 text; v10 text;

  -- Tables Leon CAN write to via this RPC (after admin approval).
  -- Add tables here when there's a clear use-case + low blast radius.
  allowed_tables text[] := ARRAY[
    'sales_reps',           -- role flips, lark_open_id, daily_send_cap, etc.
    'pipeline_leads',       -- assigned_rep_id, status, flagged, draft_html
    'helper_learnings',     -- record / supersede learnings
    'admin_inbox',          -- status updates
    'rep_questions',        -- log questions / re-classify outcome
    'canonical_onboarding_topics', -- onboarding curriculum (admin-approved)
    'dynamic_tools',        -- approve/reject Leon-authored tools
    'dynamic_writes',       -- this loop itself (mark applied, etc)
    'doc_edit_proposals',   -- approve doc edits
    'person_enrichment_candidates'  -- merge-review queue
  ];

  -- Tables Leon NEVER writes to even with admin approval. These are
  -- the audit/integrity/compliance tables. The data here must reflect
  -- real-world events, not bot decisions.
  forbidden_tables text[] := ARRAY[
    'emails',                       -- email send/delivery state — audit trail
    'webhook_events',               -- Resend webhook ground truth
    'email_contact_history',        -- dedup/compliance
    'outbound_send_log',
    'email_template_overrides_history',
    'cron_logs',
    'lark_messages',                -- chat history is authoritative
    'helper_messages',              -- same
    'sales_reps_audit',             -- if/when we add audit table
    'sessions',                     -- auth state
    'auth_tokens'
  ];

BEGIN
  trimmed := trim(sql_text);
  WHILE right(trimmed, 1) = ';' LOOP
    trimmed := left(trimmed, length(trimmed) - 1);
    trimmed := trim(trimmed);
  END LOOP;
  lower_sql := lower(trimmed);

  -- 1. Must be DML (one of INSERT/UPDATE/DELETE)
  IF lower_sql LIKE 'insert%' THEN
    op := 'insert';
  ELSIF lower_sql LIKE 'update%' THEN
    op := 'update';
  ELSIF lower_sql LIKE 'delete%' THEN
    op := 'delete';
  ELSE
    RAISE EXCEPTION 'Only INSERT/UPDATE/DELETE allowed (got: %)', left(trimmed, 30);
  END IF;

  -- 2a. No DDL or permission keywords anywhere in body
  IF lower_sql ~ '\m(drop|alter|grant|revoke|truncate|copy|create|comment|vacuum|reindex|begin|commit|rollback)\M' THEN
    RAISE EXCEPTION 'SQL contains forbidden keyword';
  END IF;
  -- 2b. SET ROLE blocked only when it's the actual statement (not
  --     `UPDATE foo SET role = X` which is legit DML on a 'role' column)
  IF lower_sql ~ '^\s*set\s+role\m' THEN
    RAISE EXCEPTION 'SET ROLE statement not allowed';
  END IF;

  -- 3. Single statement
  IF position(';' in trimmed) > 0 THEN
    RAISE EXCEPTION 'SQL must be a single statement (no semicolons mid-body)';
  END IF;

  -- 4. Extract target table from the statement. Naive but adequate:
  --    INSERT INTO <table>, UPDATE <table>, DELETE FROM <table>
  IF op = 'insert' THEN
    SELECT (regexp_match(lower_sql, 'insert\s+into\s+([a-z_][a-z_0-9]*)'))[1] INTO target_table;
  ELSIF op = 'update' THEN
    SELECT (regexp_match(lower_sql, 'update\s+([a-z_][a-z_0-9]*)'))[1] INTO target_table;
  ELSIF op = 'delete' THEN
    SELECT (regexp_match(lower_sql, 'delete\s+from\s+([a-z_][a-z_0-9]*)'))[1] INTO target_table;
  END IF;

  IF target_table IS NULL THEN
    RAISE EXCEPTION 'Could not identify target table from SQL';
  END IF;

  -- 5. Blacklist takes precedence over whitelist
  IF target_table = ANY(forbidden_tables) THEN
    RAISE EXCEPTION 'Table % is on the forbidden-writes list', target_table;
  END IF;

  -- 6. Must be on whitelist
  IF NOT (target_table = ANY(allowed_tables)) THEN
    RAISE EXCEPTION 'Table % is not in the allowed-writes whitelist', target_table;
  END IF;

  -- 7. statement_timeout
  PERFORM set_config('statement_timeout', '10s', true);

  -- 8. Param bind + execute
  p_count := jsonb_array_length(sql_params);
  IF p_count > 10 THEN
    RAISE EXCEPTION 'Maximum 10 parameters supported';
  END IF;
  IF p_count >= 1 THEN v1 := sql_params->>0; END IF;
  IF p_count >= 2 THEN v2 := sql_params->>1; END IF;
  IF p_count >= 3 THEN v3 := sql_params->>2; END IF;
  IF p_count >= 4 THEN v4 := sql_params->>3; END IF;
  IF p_count >= 5 THEN v5 := sql_params->>4; END IF;
  IF p_count >= 6 THEN v6 := sql_params->>5; END IF;
  IF p_count >= 7 THEN v7 := sql_params->>6; END IF;
  IF p_count >= 8 THEN v8 := sql_params->>7; END IF;
  IF p_count >= 9 THEN v9 := sql_params->>8; END IF;
  IF p_count >= 10 THEN v10 := sql_params->>9; END IF;

  IF p_count = 0 THEN
    EXECUTE trimmed;
  ELSIF p_count = 1 THEN
    EXECUTE trimmed USING v1;
  ELSIF p_count = 2 THEN
    EXECUTE trimmed USING v1, v2;
  ELSIF p_count = 3 THEN
    EXECUTE trimmed USING v1, v2, v3;
  ELSIF p_count = 4 THEN
    EXECUTE trimmed USING v1, v2, v3, v4;
  ELSIF p_count = 5 THEN
    EXECUTE trimmed USING v1, v2, v3, v4, v5;
  ELSIF p_count = 6 THEN
    EXECUTE trimmed USING v1, v2, v3, v4, v5, v6;
  ELSIF p_count = 7 THEN
    EXECUTE trimmed USING v1, v2, v3, v4, v5, v6, v7;
  ELSIF p_count = 8 THEN
    EXECUTE trimmed USING v1, v2, v3, v4, v5, v6, v7, v8;
  ELSIF p_count = 9 THEN
    EXECUTE trimmed USING v1, v2, v3, v4, v5, v6, v7, v8, v9;
  ELSE
    EXECUTE trimmed USING v1, v2, v3, v4, v5, v6, v7, v8, v9, v10;
  END IF;

  GET DIAGNOSTICS affected = ROW_COUNT;

  result := jsonb_build_object(
    'ok', true,
    'operation', op,
    'table', target_table,
    'rows_affected', affected
  );
  RETURN result;
END
$$;

NOTIFY pgrst, 'reload schema';
