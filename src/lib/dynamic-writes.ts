// dynamic_writes — Leon proposes a DB write (INSERT/UPDATE/DELETE);
// admin approves via Lark Yes/No card; on Yes the SQL runs through
// the whitelist-guarded _run_write_sql RPC and gets logged in
// db_write_log.
//
// This is what unblocks the recurring failure mode where Leon would
// say "I don't have a tool to change sales_reps.role, you go run this
// SQL." Now Leon writes the SQL, you Yes it, done.

import { supabase } from "@/lib/db";

// Mirror of the allowed_tables list in migration 091b, kept in TS for
// pre-flight validation so we can return a clean error before the
// RPC trip. Stays in sync MANUALLY — if you add a table to one, add
// it to the other.
const ALLOWED_WRITE_TABLES = new Set<string>([
  "sales_reps",
  "pipeline_leads",
  "helper_learnings",
  "admin_inbox",
  "rep_questions",
  "canonical_onboarding_topics",
  "dynamic_tools",
  "dynamic_writes",
  "doc_edit_proposals",
  "person_enrichment_candidates",
]);

const FORBIDDEN_WRITE_TABLES = new Set<string>([
  "emails",
  "webhook_events",
  "email_contact_history",
  "outbound_send_log",
  "email_template_overrides_history",
  "cron_logs",
  "lark_messages",
  "helper_messages",
  "sales_reps_audit",
  "sessions",
  "auth_tokens",
]);

// Note on "set role": Postgres has a `SET ROLE <role_name>` permission
// statement we want to block. But `UPDATE sales_reps SET role = $1`
// also contains the substring "set role". We disambiguate by only
// rejecting `SET ROLE` when it appears at the very start of the
// trimmed statement (i.e. that's the whole operation). The RPC layer
// rejects again via its own check.
const DANGEROUS_KEYWORDS =
  /\b(drop|alter|grant|revoke|truncate|copy|create|comment|vacuum|reindex|begin|commit|rollback)\b/i;
const SET_ROLE_AT_START = /^\s*set\s+role\b/i;

export interface DynamicWriteRow {
  id: string;
  name: string | null;
  description: string;
  sql_template: string;
  param_values: unknown[];
  proposal_reason: string | null;
  target_table: string | null;
  status: "pending" | "approved" | "rejected" | "applied" | "apply_failed";
  proposed_by_rep_id: number | null;
  proposed_at: string;
  approved_by_rep_id: number | null;
  approved_at: string | null;
  approval_note: string | null;
  rejected_reason: string | null;
  rejected_at: string | null;
  applied_at: string | null;
  apply_result: unknown;
  apply_error: string | null;
  inbox_id: string | null;
}

export function extractTargetTable(sql: string): string | null {
  const lower = sql.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if (lower.startsWith("insert")) {
    m = lower.match(/insert\s+into\s+([a-z_][a-z_0-9]*)/);
  } else if (lower.startsWith("update")) {
    m = lower.match(/update\s+([a-z_][a-z_0-9]*)/);
  } else if (lower.startsWith("delete")) {
    m = lower.match(/delete\s+from\s+([a-z_][a-z_0-9]*)/);
  } else {
    return null;
  }
  return m?.[1] ?? null;
}

export function validateWriteSql(
  sql: string,
): { ok: true; table: string; op: "insert" | "update" | "delete" } | { ok: false; reason: string } {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return { ok: false, reason: "SQL is empty" };
  const lower = trimmed.toLowerCase();
  let op: "insert" | "update" | "delete";
  if (lower.startsWith("insert")) op = "insert";
  else if (lower.startsWith("update")) op = "update";
  else if (lower.startsWith("delete")) op = "delete";
  else return { ok: false, reason: "SQL must start with INSERT, UPDATE, or DELETE" };

  if (SET_ROLE_AT_START.test(trimmed)) {
    return { ok: false, reason: "SET ROLE not allowed" };
  }
  if (DANGEROUS_KEYWORDS.test(trimmed)) {
    return { ok: false, reason: "SQL contains a forbidden keyword (DDL/perms)" };
  }
  if (/;/.test(trimmed)) {
    return { ok: false, reason: "SQL must be a single statement (no semicolons mid-body)" };
  }
  const table = extractTargetTable(trimmed);
  if (!table) return { ok: false, reason: "Could not identify target table" };
  if (FORBIDDEN_WRITE_TABLES.has(table)) {
    return { ok: false, reason: `Table '${table}' is on the forbidden-writes list (audit/integrity)` };
  }
  if (!ALLOWED_WRITE_TABLES.has(table)) {
    return {
      ok: false,
      reason: `Table '${table}' is not in the allowed-writes whitelist. If you really need it, ask admin to add it to migration 091b.`,
    };
  }
  return { ok: true, table, op };
}

export async function proposeDynamicWrite(args: {
  name?: string;
  description: string;
  sql_template: string;
  param_values: (string | number | boolean)[];
  proposal_reason: string;
  proposed_by_rep_id: number | null;
}): Promise<{ ok: true; id: string; inbox_id: string | null; target_table: string } | { ok: false; error: string }> {
  const check = validateWriteSql(args.sql_template);
  if (!check.ok) return { ok: false, error: `SQL invalid: ${check.reason}` };

  // Placeholder count must equal param_values count
  const placeholders = new Set(args.sql_template.match(/\$\d+/g) ?? []);
  if (placeholders.size !== args.param_values.length) {
    return {
      ok: false,
      error: `SQL has ${placeholders.size} distinct placeholders but ${args.param_values.length} param_values supplied`,
    };
  }

  const { data: row, error } = await supabase
    .from("dynamic_writes")
    .insert({
      name: args.name ?? null,
      description: args.description.slice(0, 1000),
      sql_template: args.sql_template,
      param_values: args.param_values,
      proposal_reason: args.proposal_reason.slice(0, 2000),
      target_table: check.table,
      proposed_by_rep_id: args.proposed_by_rep_id,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "insert failed" };

  // Push admin inbox card (kind=request → Yes/No)
  let inboxId: string | null = null;
  try {
    const paramPreview = args.param_values.length > 0
      ? `\n\n**Param values:** ${JSON.stringify(args.param_values).slice(0, 400)}`
      : "";
    const headline = `🗃 Leon 想 ${check.op.toUpperCase()} ${check.table}: ${(args.name ?? args.description).slice(0, 100)}`.slice(0, 200);
    const body = [
      `**Description:** ${args.description}`,
      `**Why:** ${args.proposal_reason}`,
      `**Target:** \`${check.table}\` (${check.op})`,
      `**SQL:**\n\`\`\`sql\n${args.sql_template.slice(0, 1500)}\n\`\`\`${paramPreview}`,
    ].join("\n\n");

    const enc = new TextEncoder();
    const key = `dynamic_write|${row.id}`;
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
        evidence: {
          source: "dynamic_write_proposal",
          dynamic_write_id: row.id,
          target_table: check.table,
          op: check.op,
        },
        dedup_hash: dedupHash,
      })
      .select("id")
      .single();
    inboxId = inbox?.id ?? null;
    if (inboxId) {
      await supabase.from("dynamic_writes").update({ inbox_id: inboxId }).eq("id", row.id);
      const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
      await sendAdminInboxCard({
        inbox_id: inboxId,
        kind: "request",
        headline,
        body,
        source_rep_id: args.proposed_by_rep_id,
        evidence: { source: "dynamic_write_proposal", dynamic_write_id: row.id },
      });
    }
  } catch (err) {
    console.warn("[dynamic-writes] card push failed (non-blocking):", err);
  }

  return { ok: true, id: row.id, inbox_id: inboxId, target_table: check.table };
}

/**
 * Execute a previously-approved write. Called from the admin_inbox card
 * Yes branch when evidence.dynamic_write_id is set.
 * Logs to db_write_log regardless of outcome.
 */
export async function applyDynamicWrite(args: {
  write_id: string;
  approved_by_rep_id: number;
}): Promise<{ ok: boolean; rows_affected?: number; error?: string }> {
  const { data: row, error } = await supabase
    .from("dynamic_writes")
    .select("*")
    .eq("id", args.write_id)
    .maybeSingle();
  if (error || !row) return { ok: false, error: error?.message ?? "write proposal not found" };
  const r = row as DynamicWriteRow;

  if (r.status === "applied") {
    return { ok: true, rows_affected: 0, error: "already applied (no-op)" };
  }
  if (r.status !== "pending" && r.status !== "approved") {
    return { ok: false, error: `cannot apply from status=${r.status}` };
  }

  // Re-validate at apply time (defense in depth — even if the row was
  // tampered with between proposal and approval)
  const check = validateWriteSql(r.sql_template);
  if (!check.ok) {
    await supabase
      .from("dynamic_writes")
      .update({
        status: "apply_failed",
        apply_error: `pre-apply validation: ${check.reason}`,
      })
      .eq("id", r.id);
    return { ok: false, error: `validation: ${check.reason}` };
  }

  // Execute via the safe RPC
  const { data: rpcResult, error: rpcErr } = await supabase.rpc("_run_write_sql", {
    sql_text: r.sql_template,
    sql_params: r.param_values,
  });

  const ok = !rpcErr && (rpcResult as { ok?: boolean })?.ok === true;
  const rowsAffected = ok ? Number((rpcResult as { rows_affected?: number }).rows_affected ?? 0) : 0;
  const errText = rpcErr?.message ?? null;

  await supabase
    .from("dynamic_writes")
    .update({
      status: ok ? "applied" : "apply_failed",
      approved_by_rep_id: args.approved_by_rep_id,
      approved_at: new Date().toISOString(),
      applied_at: ok ? new Date().toISOString() : null,
      apply_result: rpcResult ?? null,
      apply_error: errText,
    })
    .eq("id", r.id);

  // Log regardless
  await supabase.from("db_write_log").insert({
    source: "approved_proposal",
    source_rep_id: args.approved_by_rep_id,
    proposal_id: r.id,
    table_name: r.target_table ?? check.table,
    sql_text: r.sql_template,
    param_values: r.param_values,
    rows_affected: rowsAffected,
    ok,
    error: errText,
  });

  return ok
    ? { ok: true, rows_affected: rowsAffected }
    : { ok: false, error: errText ?? "unknown apply error" };
}

export async function rejectDynamicWrite(args: {
  write_id: string;
  rejected_by_rep_id: number;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!args.reason || args.reason.length < 5) {
    return { ok: false, error: "rejection reason ≥5 chars required" };
  }
  const { error } = await supabase
    .from("dynamic_writes")
    .update({
      status: "rejected",
      approved_by_rep_id: args.rejected_by_rep_id,
      rejected_reason: args.reason.slice(0, 1000),
      rejected_at: new Date().toISOString(),
    })
    .eq("id", args.write_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function listDynamicWrites(args: {
  status?: "pending" | "approved" | "rejected" | "applied" | "apply_failed" | "all";
  limit?: number;
}): Promise<DynamicWriteRow[]> {
  const limit = Math.max(1, Math.min(100, args.limit ?? 30));
  let q = supabase
    .from("dynamic_writes")
    .select("*")
    .order("proposed_at", { ascending: false })
    .limit(limit);
  if (args.status && args.status !== "all") q = q.eq("status", args.status);
  const { data } = await q;
  return (data ?? []) as DynamicWriteRow[];
}
