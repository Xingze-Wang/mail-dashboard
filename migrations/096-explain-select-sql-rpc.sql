-- Migration 096: _explain_sql RPC — dry-run any single-statement DML
-- or query to catch column-not-exists / table-not-exists errors at
-- propose-time, BEFORE the tool/write gets approved by admin.
--
-- Returns { ok: true } on parse success, or { ok: false, error: '<pg
-- error message>' } on failure. Accepts SELECT / WITH / INSERT /
-- UPDATE / DELETE — EXPLAIN supports all of these without actually
-- executing the mutation.
--
-- Defense in depth: same DDL/keyword blacklist as the run-RPCs.
--
-- This is the schema-grounding gate. Catches hallucinated columns
-- before admin even sees the proposal.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION _explain_sql(
  sql_text text,
  sql_params jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  trimmed text;
  lower_sql text;
  p_count int;
  v1 text; v2 text; v3 text; v4 text; v5 text;
  v6 text; v7 text; v8 text; v9 text; v10 text;
BEGIN
  trimmed := trim(sql_text);
  WHILE right(trimmed, 1) = ';' LOOP
    trimmed := left(trimmed, length(trimmed) - 1);
    trimmed := trim(trimmed);
  END LOOP;
  lower_sql := lower(trimmed);

  -- Accept SELECT / WITH / INSERT / UPDATE / DELETE. EXPLAIN is
  -- read-only against all of them (no mutation actually runs).
  IF NOT (
    lower_sql LIKE 'select%' OR lower_sql LIKE 'with%' OR
    lower_sql LIKE 'insert%' OR lower_sql LIKE 'update%' OR lower_sql LIKE 'delete%'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only SELECT/WITH/INSERT/UPDATE/DELETE allowed');
  END IF;
  IF position(';' in trimmed) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Single statement only');
  END IF;
  -- Block DDL/perms even at explain-time. INSERT/UPDATE/DELETE are
  -- separately whitelisted above so the keyword regex must not include
  -- those — defense in depth, not a single regex.
  IF lower_sql ~ '\m(drop|alter|grant|revoke|truncate|copy|create|comment|vacuum|reindex)\M' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Forbidden keyword in SQL');
  END IF;
  IF lower_sql ~ '^\s*set\s+role\m' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SET ROLE not allowed');
  END IF;

  PERFORM set_config('statement_timeout', '5s', true);

  p_count := jsonb_array_length(sql_params);
  IF p_count > 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Maximum 10 parameters supported');
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

  -- EXPLAIN doesn't return rows, just validates plan. We wrap in a
  -- BEGIN/EXCEPTION to convert any error into a return value.
  BEGIN
    IF p_count = 0 THEN
      EXECUTE 'EXPLAIN ' || trimmed;
    ELSIF p_count = 1 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1;
    ELSIF p_count = 2 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2;
    ELSIF p_count = 3 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3;
    ELSIF p_count = 4 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3, v4;
    ELSIF p_count = 5 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3, v4, v5;
    ELSIF p_count = 6 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3, v4, v5, v6;
    ELSIF p_count = 7 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3, v4, v5, v6, v7;
    ELSIF p_count = 8 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3, v4, v5, v6, v7, v8;
    ELSIF p_count = 9 THEN
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3, v4, v5, v6, v7, v8, v9;
    ELSE
      EXECUTE 'EXPLAIN ' || trimmed USING v1, v2, v3, v4, v5, v6, v7, v8, v9, v10;
    END IF;
    RETURN jsonb_build_object('ok', true);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
  END;
END
$$;

NOTIFY pgrst, 'reload schema';
