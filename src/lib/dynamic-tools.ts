// dynamic_tools — Leon-authored SQL tools.
//
// Three-phase lifecycle:
//   1. Leon proposes a tool via `proposeTool` → row inserted as pending,
//      Lark card pushed to admin with Yes/No buttons
//   2. Admin clicks Yes → status flips to approved → tool is now callable
//      from the same dispatcher as built-ins
//   3. Agent loop in runReadTool falls through to runDynamicTool when
//      the tool name isn't a built-in
//
// Safety:
//   - SQL must start with SELECT (or WITH ... SELECT) — no DDL, no DML
//   - We refuse anything matching dangerous keywords (drop|delete|update|
//     insert|alter|grant|truncate|copy|create|comment|vacuum)
//   - Statement timeout via `SET LOCAL statement_timeout` — 10s cap
//   - Param substitution via Supabase's _run_select_sql RPC (created by
//     migration 088 below if it doesn't exist) so the SQL stays
//     parameterized rather than string-interpolated.
//   - Args are validated against args_schema before substitution.

import { supabase } from "@/lib/db";

export interface DynamicToolArgsSchema {
  // argName → { type: 'string'|'number'|'boolean', default?, description? }
  [argName: string]: {
    type: "string" | "number" | "boolean";
    default?: string | number | boolean;
    description?: string;
  };
}

export interface DynamicToolRow {
  id: string;
  name: string;
  description: string;
  args_schema: DynamicToolArgsSchema;
  sql_template: string;
  param_order: string[];
  status: "pending" | "approved" | "rejected" | "deprecated";
  proposed_by_rep_id: number | null;
  proposed_at: string;
  proposal_reason: string | null;
  approved_by_rep_id: number | null;
  approved_at: string | null;
  approval_note: string | null;
  rejected_reason: string | null;
  rejected_at: string | null;
  call_count: number;
  last_called_at: string | null;
  last_error: string | null;
  inbox_id: string | null;
}

const DANGEROUS_KEYWORD = /\b(drop|delete|update|insert|alter|grant|revoke|truncate|copy|create|comment|vacuum|reindex|set\s+role|begin|commit|rollback)\b/i;

export function validateSql(sql: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return { ok: false, reason: "SQL is empty" };
  // Allow CTE-style (WITH ... SELECT ...) or plain SELECT
  if (!/^\s*(with|select)\b/i.test(trimmed)) {
    return { ok: false, reason: "SQL must start with SELECT or WITH ... SELECT" };
  }
  if (DANGEROUS_KEYWORD.test(trimmed)) {
    return { ok: false, reason: "SQL contains a forbidden keyword (DDL/DML/perms)" };
  }
  // No semicolons mid-statement (prevents stacking)
  if (/;/.test(trimmed)) {
    return { ok: false, reason: "SQL must be a single statement (no semicolons)" };
  }
  return { ok: true };
}

export function validateArgsAgainstSchema(
  args: Record<string, unknown>,
  schema: DynamicToolArgsSchema,
  paramOrder: string[],
): { ok: true; values: unknown[] } | { ok: false; reason: string } {
  const values: unknown[] = [];
  for (const argName of paramOrder) {
    const spec = schema[argName];
    if (!spec) return { ok: false, reason: `param_order references unknown arg '${argName}'` };
    let v = args[argName];
    if (v == null && spec.default !== undefined) v = spec.default;
    if (v == null) return { ok: false, reason: `missing required arg '${argName}'` };
    // Coerce + check
    if (spec.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, reason: `arg '${argName}' must be a number` };
      values.push(n);
    } else if (spec.type === "boolean") {
      values.push(Boolean(v));
    } else {
      values.push(String(v).slice(0, 2000));
    }
  }
  return { ok: true, values };
}

export async function proposeDynamicTool(args: {
  name: string;
  description: string;
  args_schema: DynamicToolArgsSchema;
  sql_template: string;
  param_order: string[];
  proposal_reason: string;
  proposed_by_rep_id: number | null;
}): Promise<{ ok: true; id: string; inbox_id: string | null } | { ok: false; error: string }> {
  // Name rules: snake_case, no clash with reserved words
  if (!/^[a-z][a-z0-9_]{2,60}$/.test(args.name)) {
    return { ok: false, error: "name must be snake_case, 3-60 chars, start with a letter" };
  }
  const sqlCheck = validateSql(args.sql_template);
  if (!sqlCheck.ok) return { ok: false, error: `SQL invalid: ${sqlCheck.reason}` };

  // Sanity: every name in param_order must appear in args_schema
  for (const p of args.param_order) {
    if (!args.args_schema[p]) {
      return { ok: false, error: `param_order has '${p}' but args_schema doesn't define it` };
    }
  }
  // Sanity: SQL must reference $1..$N for N = param_order.length (if any params)
  const placeholderCount = (args.sql_template.match(/\$\d+/g) ?? []).length;
  const uniquePlaceholders = new Set(args.sql_template.match(/\$\d+/g) ?? []);
  if (uniquePlaceholders.size !== args.param_order.length) {
    return {
      ok: false,
      error: `SQL uses ${uniquePlaceholders.size} distinct placeholders ($N) but param_order has ${args.param_order.length} entries`,
    };
  }
  if (placeholderCount > 0 && args.param_order.length === 0) {
    return { ok: false, error: "SQL has placeholders but param_order is empty" };
  }

  // Check name uniqueness (the unique constraint will also catch it but
  // we want a friendlier error)
  const { data: existing } = await supabase
    .from("dynamic_tools")
    .select("id, status")
    .eq("name", args.name)
    .maybeSingle();
  if (existing) {
    return { ok: false, error: `tool '${args.name}' already exists (status=${existing.status})` };
  }

  // SCHEMA GROUNDING: dry-run the SQL via EXPLAIN before accepting the
  // proposal. Catches hallucinated columns ("pipeline_leads.wechat_added_at")
  // and missing tables at write-time, so admin never sees bogus proposals.
  //
  // We synthesize placeholder values matching the args_schema's type so
  // EXPLAIN can parse the parameterized SQL. Best-effort: if the RPC
  // doesn't exist (migration not applied), skip the gate.
  try {
    const explainParams = args.param_order.map((p) => {
      const spec = args.args_schema[p];
      // Synthesize a sample value Postgres can bind. EXPLAIN doesn't
      // actually run the query, but it does need the placeholder to be
      // bindable to the declared type via the cast in the SQL.
      if (spec?.type === "number") return 1;
      if (spec?.type === "boolean") return false;
      return "smoke";
    });
    const { data: explainResult, error: explainErr } = await supabase.rpc("_explain_sql", {
      sql_text: args.sql_template,
      sql_params: explainParams,
    });
    if (!explainErr && explainResult && (explainResult as { ok?: boolean }).ok === false) {
      const pgError = (explainResult as { error?: string }).error ?? "unknown";
      return {
        ok: false,
        error: `SQL doesn't parse against the live schema: ${pgError}. Check column / table names. Hint: use explain_ontology to ground in real schema before writing SQL.`,
      };
    }
    // If RPC failed (e.g. migration not yet applied), don't block — log
    // and continue. Validation degrades to TS-side checks only.
    if (explainErr) {
      console.warn("[dynamic-tools] _explain_sql RPC unavailable, skipping schema gate:", explainErr.message);
    }
  } catch (e) {
    console.warn("[dynamic-tools] EXPLAIN gate threw, skipping:", e);
  }

  const { data: row, error } = await supabase
    .from("dynamic_tools")
    .insert({
      name: args.name,
      description: args.description.slice(0, 1000),
      args_schema: args.args_schema,
      sql_template: args.sql_template,
      param_order: args.param_order,
      proposed_by_rep_id: args.proposed_by_rep_id,
      proposal_reason: args.proposal_reason.slice(0, 2000),
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "insert returned no row" };

  // Push admin card (kind=request → Yes/No buttons via admin-inbox-card)
  let inboxId: string | null = null;
  try {
    const headline = `🧰 Leon 想造工具: ${args.name}`.slice(0, 200);
    const body = [
      `**Description:** ${args.description}`,
      `**Why:** ${args.proposal_reason}`,
      `**Args:** ${JSON.stringify(args.args_schema, null, 2).slice(0, 600)}`,
      `**SQL:**\n\`\`\`sql\n${args.sql_template.slice(0, 1500)}\n\`\`\``,
    ].join("\n\n");
    const enc = new TextEncoder();
    const key = `dynamic_tool|${args.name}`;
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
    const dedupHash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const { data: inbox } = await supabase
      .from("admin_inbox")
      .insert({
        kind: "request",
        headline,
        body,
        source_rep_id: args.proposed_by_rep_id,
        evidence: { source: "dynamic_tool_proposal", dynamic_tool_id: row.id, dynamic_tool_name: args.name },
        dedup_hash: dedupHash,
      })
      .select("id")
      .single();
    inboxId = inbox?.id ?? null;
    if (inboxId) {
      await supabase.from("dynamic_tools").update({ inbox_id: inboxId }).eq("id", row.id);
      const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
      await sendAdminInboxCard({
        inbox_id: inboxId,
        kind: "request",
        headline,
        body,
        source_rep_id: args.proposed_by_rep_id,
        evidence: { source: "dynamic_tool_proposal", dynamic_tool_id: row.id, dynamic_tool_name: args.name },
      });
    }
  } catch (err) {
    console.warn("[dynamic-tools] card push failed (non-blocking):", err);
  }

  return { ok: true, id: row.id, inbox_id: inboxId };
}

export async function approveDynamicTool(args: {
  tool_id: string;
  approved_by_rep_id: number;
  note?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: row, error } = await supabase
    .from("dynamic_tools")
    .select("status")
    .eq("id", args.tool_id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!row) return { ok: false, error: "tool not found" };
  if (row.status === "approved") return { ok: true };  // idempotent
  if (row.status !== "pending") return { ok: false, error: `cannot approve from status=${row.status}` };

  const { error: updErr } = await supabase
    .from("dynamic_tools")
    .update({
      status: "approved",
      approved_by_rep_id: args.approved_by_rep_id,
      approved_at: new Date().toISOString(),
      approval_note: args.note?.slice(0, 1000) ?? null,
    })
    .eq("id", args.tool_id);
  if (updErr) return { ok: false, error: updErr.message };
  return { ok: true };
}

export async function rejectDynamicTool(args: {
  tool_id: string;
  rejected_by_rep_id: number;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!args.reason || args.reason.length < 5) {
    return { ok: false, error: "rejection reason ≥5 chars required" };
  }
  const { error } = await supabase
    .from("dynamic_tools")
    .update({
      status: "rejected",
      approved_by_rep_id: args.rejected_by_rep_id,
      rejected_reason: args.reason.slice(0, 1000),
      rejected_at: new Date().toISOString(),
    })
    .eq("id", args.tool_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Look up an approved dynamic tool by name.
 * Returns null if not found / not approved.
 */
export async function loadApprovedTool(name: string): Promise<DynamicToolRow | null> {
  const { data } = await supabase
    .from("dynamic_tools")
    .select("*")
    .eq("name", name)
    .eq("status", "approved")
    .maybeSingle();
  return (data as DynamicToolRow | null) ?? null;
}

/**
 * Execute a dynamic tool by name. Validates args against the schema,
 * substitutes them into the SQL, runs with a 10s statement timeout.
 *
 * Returns whatever the SQL returns, capped at 200 rows.
 */
export async function runDynamicTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; rows: unknown[]; tool: DynamicToolRow } | { ok: false; error: string }> {
  const tool = await loadApprovedTool(name);
  if (!tool) return { ok: false, error: `dynamic tool '${name}' not found or not approved` };

  const validated = validateArgsAgainstSchema(args, tool.args_schema, tool.param_order);
  if (!validated.ok) return { ok: false, error: validated.reason };

  // Re-validate SQL at run time (in case admin edited the row by hand)
  const sqlCheck = validateSql(tool.sql_template);
  if (!sqlCheck.ok) return { ok: false, error: `SQL no longer valid: ${sqlCheck.reason}` };

  // Execute via the safe RPC. _run_select_sql wraps in a transaction
  // with statement_timeout=10s and runs only SELECT.
  try {
    // sql_params is JSONB on the postgres side — pass an array literal
    // and supabase-js will JSON-encode it as an array.
    const { data, error } = await supabase.rpc("_run_select_sql", {
      sql_text: tool.sql_template,
      sql_params: validated.values,  // JSON-encoded into jsonb by the client
    });
    if (error) {
      // Record the error on the tool row so admin can see what's failing
      await supabase
        .from("dynamic_tools")
        .update({
          call_count: tool.call_count + 1,
          last_called_at: new Date().toISOString(),
          last_error: error.message.slice(0, 1000),
        })
        .eq("id", tool.id);
      return { ok: false, error: error.message };
    }
    // Success — clear last_error, bump count
    await supabase
      .from("dynamic_tools")
      .update({
        call_count: tool.call_count + 1,
        last_called_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", tool.id);
    // Cap rows to keep model context manageable
    const rows = Array.isArray(data) ? (data as unknown[]).slice(0, 200) : [data];
    return { ok: true, rows, tool };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 1000) };
  }
}

export async function listDynamicTools(args: {
  status?: "pending" | "approved" | "rejected" | "deprecated" | "all";
  limit?: number;
}): Promise<DynamicToolRow[]> {
  const limit = Math.max(1, Math.min(100, args.limit ?? 50));
  let q = supabase
    .from("dynamic_tools")
    .select("*")
    .order("proposed_at", { ascending: false })
    .limit(limit);
  if (args.status && args.status !== "all") q = q.eq("status", args.status);
  const { data } = await q;
  return (data ?? []) as DynamicToolRow[];
}
