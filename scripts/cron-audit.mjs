import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const now = new Date();
const isoNow = now.toISOString();

// (label, table, ts_col, optional filter)
const checks = [
  // master cron — pipeline_leads from scan
  ['master /api/cron (pipeline_leads insert)', 'pipeline_leads', 'created_at', null],
  // standup — lark_messages with brief
  ['standup', 'lark_messages', 'created_at', { col: 'kind', val: 'standup' }],
  // weekly-checkin — lark_messages with kind=weekly_checkin
  ['weekly-checkin', 'lark_messages', 'created_at', { col: 'kind', val: 'weekly_checkin' }],
  // wechat-followup — sends lark message; writes brief_lookups? actually it reads
  ['wechat-followup (lark_messages kind=wechat_followup)', 'lark_messages', 'created_at', { col: 'kind', val: 'wechat_followup' }],
  // onboarding-followup — sales_reps.followup_d1_sent_at
  ['onboarding-followup (sales_reps.followup_d1_sent_at)', 'sales_reps', 'followup_d1_sent_at', null],
  // template-proposals — email_templates inserts + admin_inbox
  ['template-proposals (email_templates updated_at)', 'email_templates', 'updated_at', null],
  // propose-templates-to-reps — email_templates proposed_to_rep_at
  ['propose-templates-to-reps (proposed_to_rep_at)', 'email_templates', 'proposed_to_rep_at', null],
  // rep-edit-clustering — email_templates insert
  ['rep-edit-clustering (email_templates created_at where source=clustering)', 'email_templates', 'created_at', null],
  // candidate-global-promote — admin_inbox or email_templates
  ['candidate-global-promote (admin_inbox created_at)', 'admin_inbox', 'created_at', null],
  // template-auto-promote — email_templates promote_at? / updates
  ['template-auto-promote (email_templates.updated_at)', 'email_templates', 'updated_at', null],
  // insights-realign — insights_snapshots
  ['insights-realign (insights_snapshots)', 'insights_snapshots', 'created_at', null],
  // insights-prewarm — insights_llm_cache
  ['insights-prewarm (insights_llm_cache)', 'insights_llm_cache', 'updated_at', null],
  // daily-rep-brief — daily_rep_brief
  ['daily-rep-brief', 'daily_rep_brief', 'updated_at', null],
  // congress-topic-propose — congress_debate_proposals
  ['congress-topic-propose', 'congress_debate_proposals', 'created_at', null],
  // model-bench-eval — model_predictions
  ['model-bench-eval (model_predictions)', 'model_predictions', 'created_at', null],
  // heuristic-seed — missions insert
  ['missions/heuristic-seed (missions)', 'missions', 'created_at', null],
  // allocate-leads — missions / allocation_log
  ['missions/allocate-leads (allocation_log)', 'allocation_log', 'created_at', null],
  // onboarding-quota-check — rep_daily_quotas_override
  ['onboarding-quota-check (rep_daily_quotas_override)', 'rep_daily_quotas_override', 'created_at', null],
  // enrich-h-index — pipeline_leads h_index updates
  ['enrich-h-index (pipeline_leads h_index not null updated_at)', 'pipeline_leads', 'updated_at', null],
  // congress/jitr-tick — jitr_offers
  ['congress/jitr-tick (jitr_offers)', 'jitr_offers', 'offered_at', null],
  // congress/weekly — tactical_proposals
  ['congress/weekly (tactical_proposals)', 'tactical_proposals', 'created_at', null],
  // congress/monthly — strategic_decisions
  ['congress/monthly (strategic_decisions)', 'strategic_decisions', 'created_at', null],
  // congress/postmortem-detect — postmortem trigger; maybe lark_messages
  ['congress/postmortem-detect (lark_messages kind=postmortem_alert?)', 'lark_messages', 'created_at', null],
  // congress-chime — helper_chime_in_log
  ['congress-chime', 'helper_chime_in_log', 'created_at', null],
  // pipeline/scan-fanout — pipeline_leads
  ['pipeline/scan-fanout (pipeline_leads)', 'pipeline_leads', 'created_at', null],
];

async function check([label, table, col, filt]) {
  try {
    let q = s.from(table).select(`id, ${col}`).order(col, { ascending: false }).limit(1);
    if (filt) q = q.eq(filt.col, filt.val);
    const { data, error } = await q;
    if (error) return [label, `ERR: ${error.message.slice(0, 80)}`];
    if (!data || data.length === 0) return [label, `(no rows in ${table})`];
    const ts = data[0][col];
    if (!ts) return [label, `latest row in ${table} has null ${col}`];
    const ageH = ((now - new Date(ts)) / 3600000).toFixed(1);
    return [label, `${table}.${col} latest=${ts} (${ageH}h ago)`];
  } catch (e) {
    return [label, `EXC: ${String(e).slice(0, 80)}`];
  }
}

const out = await Promise.all(checks.map(check));
for (const [l, r] of out) console.log(`[${l}] => ${r}`);
