-- 086-doc-edit-proposals.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--
-- doc_edit_proposals: queue of doc edits the bot wants to make to a
-- Lark/Feishu docx, awaiting admin approval. Mirrors template_edits
-- (mig 069) in spirit — propose, queue, admin approves, then apply.
--
-- WHY a queue instead of direct edit:
-- - The user's north-star rule says "the bot can do anything the app
--   can do, but some require admin approval." Editing a published doc
--   the team relies on is destructive (collaborators see the changes
--   immediately, no undo button in Lark's UI), so it needs approval.
-- - The agent has to be HONEST about what it's changing — a structured
--   edit list (update/delete/insert) is auditable; a free-text "I'll
--   edit X" is not.
--
-- 2. WHO WRITES
--   - POST /api/lark-doc/proposals — Leon proposes via tool call
--     `propose_doc_edit` (wired into helper-read-tools.ts dispatcher)
--   - The proposal row stores the entire edit spec so the apply step
--     is deterministic from the row alone.
--
-- 3. WHO READS
--   - Admin Lark card (sendDocEditCard) — same UX as the
--     admin_inbox card; Approve / Reject / Dismiss buttons
--   - GET /admin/doc-edits (NEW page) — list pending; review diff;
--     approve from web
--   - Apply flow: when approved, the apply worker reads `edits` jsonb
--     and dispatches each step via the lib/lark.ts primitives
--     (updateLarkDocBlock / deleteLarkDocBlocks / insertLarkDocBlocksAt)
--
-- 4. BACKFILL
--   Empty at start. The proposal-driven flow only kicks in when an
--   admin asks Leon to edit a doc.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS doc_edit_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lark docx the edits target. Stored as the Lark document_id (the
  -- string in /docx/{id} URLs), not our internal UUID — these are
  -- external resources.
  document_id     text NOT NULL,
  document_url    text NOT NULL,
  document_title  text,                          -- snapshot, may drift

  -- The agent's plain-language summary of what these edits accomplish.
  -- This is what shows on the Lark approve-card so admin can decide
  -- without reading the JSON diff. ≤300 chars enforced at write.
  summary         text NOT NULL,

  -- Structured edit spec — array of {action, ...args}. See the
  -- propose_doc_edit tool doc for the schema. Apply step iterates this
  -- in order. Storing as jsonb so admin can see/edit in the dashboard
  -- if needed.
  edits           jsonb NOT NULL,

  -- Bot's self-reporting field. Plain-text honest narration:
  -- "I'm rewriting the second paragraph for clarity and adding a TL;DR
  -- callout at the top." Differs from `summary` (≤300 char tagline) by
  -- being unstructured prose with reasoning.
  narration       text,

  -- Who proposed. NULL only allowed transitionally; in practice the
  -- bot is always acting on behalf of someone.
  proposed_by_rep_id  int REFERENCES sales_reps(id),

  -- Lifecycle: pending → approved → applied
  --                    └→ rejected
  --                    └→ dismissed (admin saw but skipped)
  -- "applied" is set after the apply worker finishes the Lark API
  -- calls successfully. Failed applies stay 'approved' with an
  -- apply_error field set, so we can retry.
  status              text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'dismissed', 'applied')),
  decided_by_rep_id   int REFERENCES sales_reps(id),
  decided_at          timestamptz,
  decision_note       text,                      -- admin's reject reason / approve comment

  -- Apply tracking
  applied_at          timestamptz,
  apply_error         text,                      -- non-null if apply failed
  apply_result        jsonb,                     -- per-step success/fail trace

  -- Bookkeeping
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doc_edit_proposals_pending
  ON doc_edit_proposals (status, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS doc_edit_proposals_by_doc
  ON doc_edit_proposals (document_id, created_at DESC);
