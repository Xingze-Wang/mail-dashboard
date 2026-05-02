-- migrations/035-person-enrichment-candidates.sql
--
-- 1. SCHEMA CHANGE
-- New table person_enrichment_candidates: holds proposed HF/GitHub/
-- personal-site links for a person that did NOT meet the auto-write
-- confidence threshold (0.85). Two-layer model: high-confidence links
-- go directly into persons.hf_users / github_users; ambiguous ones
-- land here for the merge-review queue.
--
-- 2. WHO WRITES THIS?
-- scripts/enrich-person-skill.md / dispatched agents. Each agent that
-- finds a candidate at confidence < 0.85 logs it here instead of the
-- main persons row.
--
-- 3. WHO READS THIS?
-- Future admin UI: /admin/person-review surfaces top candidates +
-- evidence for human approval. Approved → moved to persons.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new table.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

create table if not exists person_enrichment_candidates (
  id            uuid primary key default gen_random_uuid(),
  person_id     text not null references persons(id) on delete cascade,
  field         text not null,        -- 'hf_users' | 'github_users' | 'real_name' | 'affiliation' | 'personal_site'
  value         text not null,        -- the proposed string ('wzhang-thu', 'wzhang.xyz', 'Wei Zhang', ...)
  confidence    double precision not null,  -- 0.0 to 1.0
  evidence      jsonb not null default '{}'::jsonb,
                                       -- { sources: ['hf_profile_link', 'github_commit_email_match'],
                                       --   signals: { ... },
                                       --   agent_id: 'agent-7' }
  status        text not null default 'pending',  -- pending | approved | rejected
  reviewed_by   text,                  -- rep/admin email when approved/rejected
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_pec_person on person_enrichment_candidates(person_id);
create index if not exists idx_pec_status on person_enrichment_candidates(status, confidence desc);
create index if not exists idx_pec_field_value on person_enrichment_candidates(field, value);

-- Same value can be proposed for the same person multiple times
-- (different agents, different evidence). Unique on the triple
-- prevents identical duplicates but allows differentiated proposals.
create unique index if not exists uniq_pec_person_field_value
  on person_enrichment_candidates(person_id, field, value)
  where status = 'pending';

notify pgrst, 'reload schema';
