-- ═══════════════════════════════════════════════════════════════════
-- Migration 015: Pipeline_leads bounce + complaint tracking
--
-- Resend webhooks (email.bounced, email.complained) previously only
-- updated the emails table. pipeline_leads.status stayed at 'sent'
-- regardless, so reps couldn't see which sends never landed. We don't
-- want to regress the status string (it's used for ready/sent/replied
-- transitions and overwriting it would lose reply signal), so we add
-- two dedicated timestamp columns that the webhook populates.
--
-- Metrics can now surface "X bounced this week" and the drift miner
-- can filter them out of "good sends" samples.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table pipeline_leads add column if not exists bounced_at    timestamptz;
alter table pipeline_leads add column if not exists complained_at timestamptz;

create index if not exists idx_pipeline_leads_bounced
  on pipeline_leads (bounced_at) where bounced_at is not null;
create index if not exists idx_pipeline_leads_complained
  on pipeline_leads (complained_at) where complained_at is not null;
