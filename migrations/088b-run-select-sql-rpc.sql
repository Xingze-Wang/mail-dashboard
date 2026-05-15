-- Migration 088b: _run_select_sql RPC for dynamic_tools
--
-- Helper function that:
--   - Executes a single SELECT with parameter substitution
--   - Hard-caps statement time at 10s
--   - Rejects anything not starting with SELECT or WITH
--   - Returns rows as JSONB so PostgREST can hand them back as JSON
--
-- This is the sandbox boundary for Leon-authored tools. Even if
-- validateSql in TS leaks a bad statement through, this RPC won't
-- run it.
--
-- Idempotent.

-- We keep the param array as jsonb because Supabase's RPC mapping to
-- anyarray with mixed types (number/string/boolean) is messy. The
-- caller passes a JSONB array; we EXPAND it into named placeholders.
CREATE OR REPLACE FUNCTION _run_select_sql(
  sql_text text,
  sql_params jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  trimmed text;
  result jsonb;
  p_count int;
  v1 text; v2 text; v3 text; v4 text; v5 text;
  v6 text; v7 text; v8 text; v9 text; v10 text;
BEGIN
  trimmed := trim(sql_text);
  WHILE right(trimmed, 1) = ';' LOOP
    trimmed := left(trimmed, length(trimmed) - 1);
    trimmed := trim(trimmed);
  END LOOP;

  IF NOT (lower(trimmed) LIKE 'select%' OR lower(trimmed) LIKE 'with%') THEN
    RAISE EXCEPTION 'Only SELECT or WITH ... SELECT statements are allowed';
  END IF;
  IF position(';' in trimmed) > 0 THEN
    RAISE EXCEPTION 'SQL must be a single statement (no semicolons)';
  END IF;
  IF lower(trimmed) ~ '\m(drop|delete|update|insert|alter|grant|revoke|truncate|copy|create|comment|vacuum|reindex)\M' THEN
    RAISE EXCEPTION 'SQL contains a forbidden keyword';
  END IF;

  PERFORM set_config('statement_timeout', '10s', true);

  -- Pull each jsonb array element into a text variable. Cast happens
  -- in the SQL itself (e.g. $1::int) if the tool needs a non-text type.
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

  -- Dispatch on param count — EXECUTE ... USING needs a fixed arity.
  IF p_count = 0 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result;
  ELSIF p_count = 1 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1;
  ELSIF p_count = 2 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2;
  ELSIF p_count = 3 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3;
  ELSIF p_count = 4 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3, v4;
  ELSIF p_count = 5 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3, v4, v5;
  ELSIF p_count = 6 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3, v4, v5, v6;
  ELSIF p_count = 7 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3, v4, v5, v6, v7;
  ELSIF p_count = 8 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3, v4, v5, v6, v7, v8;
  ELSIF p_count = 9 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3, v4, v5, v6, v7, v8, v9;
  ELSE
    EXECUTE format('SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', trimmed) INTO result USING v1, v2, v3, v4, v5, v6, v7, v8, v9, v10;
  END IF;

  RETURN result;
END;
$$;

NOTIFY pgrst, 'reload schema';
