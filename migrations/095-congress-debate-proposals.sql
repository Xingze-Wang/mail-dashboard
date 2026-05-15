-- Migration 095: congress_debate_proposals — LLM-suggested topics for
-- next Monday's tactical congress. Mid-week cron drops 1-3 candidates
-- into this table; admin reviews via /admin/inbox card (kind=idea);
-- approved ones become formal tactical_proposals for Monday's run.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS congress_debate_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ISO date of the Monday this is FOR (next Monday from cron run date)
  for_congress_on date NOT NULL,
  -- Topic shape: a question the congress should debate.
  topic_title     text NOT NULL,
  topic_body      text NOT NULL,            -- 2-4 sentence brief
  -- Evidence the LLM saw when proposing it (which dimensions, which
  -- inbox rows, which dates). Lets admin verify the rationale.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_model  text,

  -- Lifecycle. Once admin approves, the congress runner picks it up
  -- and converts to a real tactical_proposals row.
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
  approved_by_rep_id  int REFERENCES sales_reps(id),
  approved_at         timestamptz,
  rejected_reason     text,

  -- The admin_inbox card pushed for admin review
  inbox_id        uuid REFERENCES admin_inbox(id),

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_congress_debate_pending
  ON congress_debate_proposals (for_congress_on, status)
  WHERE status = 'pending';

NOTIFY pgrst, 'reload schema';
