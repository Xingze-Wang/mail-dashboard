// Doc-edit proposal + apply pipeline.
//
// Flow:
//   1. Agent (Leon via Lark or web) emits `propose_doc_edit` tool call
//      → proposeDocEdit() writes a row to doc_edit_proposals + pushes
//      a Lark approve card to admin.
//   2. Admin clicks Approve (or fires `approve_doc_edit` action via
//      Lark text / dashboard button) → applyDocEditProposal() runs the
//      structured edits against the real Lark docx.
//   3. Result is persisted on the row (applied_at, apply_result, or
//      apply_error) so admin sees what actually landed.
//
// Edit-step schema (stored in doc_edit_proposals.edits jsonb):
//   { action: "update", block_id: string, block_type: number, new_text: string }
//   { action: "delete", block_ids: string[] }
//   { action: "insert_at", index: number, blocks: RichBlock[] }
//   { action: "append", blocks: RichBlock[] }
//
// Why structured edits, not "regenerate the whole doc": LLMs are bad
// at preserving unchanged sections verbatim. Targeting block_ids forces
// the agent to identify exactly what changes — and gives admin a
// honest diff to approve, not a wall of regenerated text.

import { supabase } from "@/lib/db";
import {
  updateLarkDocBlock,
  deleteLarkDocBlocks,
  insertLarkDocBlocksAt,
  appendToLarkDoc,
  type RichBlock,
} from "@/lib/lark";

export type DocEditStep =
  | { action: "update"; block_id: string; block_type: number; new_text: string }
  | { action: "delete"; block_ids: string[] }
  | { action: "insert_at"; index: number; blocks: RichBlock[] }
  | { action: "append"; blocks: RichBlock[] };

export interface DocEditProposalRow {
  id: string;
  document_id: string;
  document_url: string;
  document_title: string | null;
  summary: string;
  edits: DocEditStep[];
  narration: string | null;
  proposed_by_rep_id: number | null;
  status: "pending" | "approved" | "rejected" | "dismissed" | "applied";
  decided_by_rep_id: number | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_at: string | null;
  apply_error: string | null;
  apply_result: unknown;
  created_at: string;
}

/**
 * Write a doc-edit proposal to the queue. Caller has already validated
 * the edits[] payload structurally; we trust them here. Best-effort
 * pushes an admin Lark card so the proposal is reviewable from the
 * same surface admin lives on. Card push failure does NOT block the
 * row insert — the dashboard /admin/doc-edits page is the fallback.
 */
export async function proposeDocEdit(args: {
  document_id: string;
  document_url: string;
  document_title?: string | null;
  summary: string;
  edits: DocEditStep[];
  narration?: string | null;
  proposed_by_rep_id: number | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const summary = args.summary.trim().slice(0, 300);
  if (summary.length < 5) return { ok: false, error: "summary too short" };
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return { ok: false, error: "edits[] required and non-empty" };
  }
  if (args.edits.length > 100) {
    return { ok: false, error: "too many edits (max 100 per proposal)" };
  }

  const { data, error } = await supabase
    .from("doc_edit_proposals")
    .insert({
      document_id: args.document_id,
      document_url: args.document_url,
      document_title: args.document_title ?? null,
      summary,
      edits: args.edits,
      narration: args.narration ?? null,
      proposed_by_rep_id: args.proposed_by_rep_id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  // Push an admin Lark card. Best-effort — admins also see it in the
  // dashboard /admin/doc-edits page.
  void pushDocEditCard(data.id as string).catch((e) => {
    console.error("[doc-edit-proposals] card push failed:", e);
  });

  return { ok: true, id: data.id as string };
}

/**
 * Look up admin's lark_open_id and push a text DM (not interactive
 * card — keeping shape simple to dodge the 200340 card-callback hell
 * we've been fighting). Admin can approve via Lark text "approve doc
 * edit X" or via the dashboard button — both routes call
 * approveDocEditProposal().
 */
async function pushDocEditCard(proposalId: string): Promise<void> {
  const { data: row } = await supabase
    .from("doc_edit_proposals")
    .select("id, document_title, document_url, summary, narration, edits")
    .eq("id", proposalId)
    .maybeSingle();
  if (!row) return;

  const { data: admins } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("role", "admin")
    .eq("active", true)
    .not("lark_open_id", "is", null);
  if (!admins || admins.length === 0) return;

  const editsArr = Array.isArray(row.edits) ? (row.edits as DocEditStep[]) : [];
  const editCount = editsArr.length;
  const breakdown = editsArr.reduce((acc, e) => {
    acc[e.action] = (acc[e.action] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const text = [
    `📝 **Doc edit proposal** — ${row.document_title ?? "(untitled)"}`,
    ``,
    `${row.summary}`,
    ``,
    row.narration ? `_Narration:_ ${(row.narration as string).slice(0, 300)}` : "",
    ``,
    `**Changes**: ${editCount} edit${editCount === 1 ? "" : "s"} (${Object.entries(breakdown).map(([k, v]) => `${v} ${k}`).join(", ")})`,
    ``,
    `Doc: ${row.document_url}`,
    `Proposal id: \`${row.id}\``,
    ``,
    `Reply: "approve doc edit ${(row.id as string).slice(0, 8)}" 或 "reject doc edit ${(row.id as string).slice(0, 8)} <reason>" — 也可以在 /admin/doc-edits 网页里操作.`,
  ].filter(Boolean).join("\n");

  const { sendMessage } = await import("@/lib/lark");
  for (const a of admins) {
    try {
      await sendMessage({
        receive_id: a.lark_open_id as string,
        receive_id_type: "open_id",
        text,
      });
    } catch {/* swallow */}
  }
}

/**
 * Apply an approved proposal — runs the edits[] against the real Lark
 * docx in order. Per-step success/fail trace is stored in
 * apply_result so admin can see what actually landed.
 *
 * On any step failure: we stop and store the error. Partial apply is
 * legitimate (some blocks moved, some didn't); the row stays at
 * status='approved' so admin can retry after fixing the issue.
 *
 * Idempotency: re-applying an already-'applied' row is rejected with
 * a clear error rather than re-running and creating double-inserts.
 */
export async function applyDocEditProposal(args: {
  proposal_id: string;
  decided_by_rep_id: number;
}): Promise<{ ok: boolean; applied_steps?: number; error?: string }> {
  const { data: row, error: loadErr } = await supabase
    .from("doc_edit_proposals")
    .select("*")
    .eq("id", args.proposal_id)
    .maybeSingle();
  if (loadErr || !row) return { ok: false, error: loadErr?.message ?? "proposal not found" };
  if (row.status === "applied") {
    return { ok: false, error: "already applied — can't re-apply" };
  }
  if (row.status === "rejected" || row.status === "dismissed") {
    return { ok: false, error: `proposal is ${row.status}, can't apply` };
  }

  const edits = (row.edits as DocEditStep[]) ?? [];
  const documentId = row.document_id as string;
  const trace: Array<{ step: number; action: string; ok: boolean; detail?: string }> = [];

  for (let i = 0; i < edits.length; i++) {
    const step = edits[i];
    try {
      let stepOk = false;
      let stepDetail = "";
      switch (step.action) {
        case "update": {
          const r = await updateLarkDocBlock({
            document_id: documentId,
            block_id: step.block_id,
            block_type: step.block_type,
            new_text: step.new_text,
          });
          stepOk = r.ok;
          stepDetail = r.ok ? `updated block ${step.block_id}` : (r.error ?? "update failed");
          break;
        }
        case "delete": {
          const r = await deleteLarkDocBlocks({
            document_id: documentId,
            block_ids: step.block_ids,
          });
          stepOk = r.ok;
          stepDetail = r.ok ? `deleted ${r.deleted} block(s)` : (r.error ?? "delete failed");
          break;
        }
        case "insert_at": {
          const r = await insertLarkDocBlocksAt({
            document_id: documentId,
            index: step.index,
            blocks: step.blocks,
          });
          stepOk = r.ok;
          stepDetail = r.ok ? `inserted ${r.blocks_inserted} block(s) at index ${step.index}` : (r.error ?? "insert failed");
          break;
        }
        case "append": {
          const r = await appendToLarkDoc({
            document_id: documentId,
            blocks: step.blocks,
          });
          stepOk = r.ok;
          stepDetail = r.ok ? `appended ${r.blocks_appended} block(s)` : (r.error ?? "append failed");
          break;
        }
      }
      trace.push({ step: i, action: step.action, ok: stepOk, detail: stepDetail });
      if (!stepOk) {
        // Stop on first failure. Don't mark applied — admin can retry.
        await supabase
          .from("doc_edit_proposals")
          .update({
            apply_error: `step ${i} (${step.action}) failed: ${stepDetail}`,
            apply_result: { trace },
            decided_by_rep_id: args.decided_by_rep_id,
          })
          .eq("id", args.proposal_id);
        return { ok: false, applied_steps: i, error: stepDetail };
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      trace.push({ step: i, action: step.action, ok: false, detail: msg });
      await supabase
        .from("doc_edit_proposals")
        .update({
          apply_error: `step ${i} (${step.action}) threw: ${msg}`,
          apply_result: { trace },
          decided_by_rep_id: args.decided_by_rep_id,
        })
        .eq("id", args.proposal_id);
      return { ok: false, applied_steps: i, error: msg };
    }
  }

  // All steps OK — mark applied.
  await supabase
    .from("doc_edit_proposals")
    .update({
      status: "applied",
      applied_at: new Date().toISOString(),
      apply_result: { trace },
      decided_by_rep_id: args.decided_by_rep_id,
      decided_at: new Date().toISOString(),
      apply_error: null,
    })
    .eq("id", args.proposal_id);

  return { ok: true, applied_steps: edits.length };
}

/**
 * Lifecycle helpers used by both the Lark text path and the dashboard
 * approve/reject buttons. These keep status transitions in one place.
 */

export async function approveDocEditProposal(args: {
  proposal_id: string;
  decided_by_rep_id: number;
  decision_note?: string | null;
  apply_now?: boolean;                  // default true — flip to approved AND run apply
}): Promise<{ ok: boolean; applied_steps?: number; error?: string }> {
  // Move to approved first so the apply step's trace lands consistently.
  const { error } = await supabase
    .from("doc_edit_proposals")
    .update({
      status: "approved",
      decided_by_rep_id: args.decided_by_rep_id,
      decided_at: new Date().toISOString(),
      decision_note: args.decision_note ?? null,
    })
    .eq("id", args.proposal_id)
    .eq("status", "pending");           // only transition pending → approved
  if (error) return { ok: false, error: error.message };

  if (args.apply_now === false) {
    return { ok: true };
  }
  return applyDocEditProposal({
    proposal_id: args.proposal_id,
    decided_by_rep_id: args.decided_by_rep_id,
  });
}

export async function rejectDocEditProposal(args: {
  proposal_id: string;
  decided_by_rep_id: number;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!args.reason || args.reason.trim().length < 10) {
    return { ok: false, error: "reject reason must be ≥10 chars (it goes into next congress evidence pack)" };
  }
  const { error } = await supabase
    .from("doc_edit_proposals")
    .update({
      status: "rejected",
      decided_by_rep_id: args.decided_by_rep_id,
      decided_at: new Date().toISOString(),
      decision_note: args.reason.trim().slice(0, 1500),
    })
    .eq("id", args.proposal_id)
    .eq("status", "pending");
  return error ? { ok: false, error: error.message } : { ok: true };
}
