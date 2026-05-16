import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const now = new Date();

// Each: [label, fn -> {label, info}]
const fns = [
  // master /api/cron
  async () => {
    const { data } = await s.from('pipeline_leads').select('id, created_at').order('created_at', { ascending: false }).limit(1);
    return ['master /api/cron (pipeline_leads insert)', fmt('pipeline_leads.created_at', data?.[0]?.created_at)];
  },
  // standup — looking at lark_messages where role likely = assistant, text contains keyword
  async () => {
    const { data } = await s.from('lark_messages').select('id, created_at, text').ilike('text','%standup%').order('created_at',{ascending:false}).limit(1);
    return ['standup (lark_messages text~standup)', fmt('lark_messages.created_at', data?.[0]?.created_at)];
  },
  // weekly-checkin
  async () => {
    const { data } = await s.from('lark_messages').select('id, created_at, text').ilike('text','%周报%').order('created_at',{ascending:false}).limit(1);
    return ['weekly-checkin (lark_messages text~周报)', fmt('lark_messages.created_at', data?.[0]?.created_at)];
  },
  // wechat-followup — sends a Lark message; check helper_chime_in_log with kind=wechat_followup OR lark_messages
  async () => {
    const { data } = await s.from('helper_chime_in_log').select('id, pushed_at, kind').eq('kind','wechat_followup').order('pushed_at',{ascending:false}).limit(1);
    return ['wechat-followup (helper_chime_in_log kind=wechat_followup)', fmt('helper_chime_in_log.pushed_at', data?.[0]?.pushed_at)];
  },
  // onboarding-followup
  async () => {
    const { data: d1 } = await s.from('sales_reps').select('id, followup_d1_sent_at').not('followup_d1_sent_at','is',null).order('followup_d1_sent_at',{ascending:false}).limit(1);
    const { data: d7 } = await s.from('sales_reps').select('id, followup_d7_sent_at').not('followup_d7_sent_at','is',null).order('followup_d7_sent_at',{ascending:false}).limit(1);
    return ['onboarding-followup (sales_reps.followup_d1/d7_sent_at)', `d1=${d1?.[0]?.followup_d1_sent_at||'(none)'} d7=${d7?.[0]?.followup_d7_sent_at||'(none)'}`];
  },
  // template-proposals — admin_inbox with kind ~ template_proposal
  async () => {
    const { data } = await s.from('admin_inbox').select('id, created_at, kind').ilike('kind','%template%').order('created_at',{ascending:false}).limit(1);
    return ['template-proposals (admin_inbox kind~template)', fmt('admin_inbox.created_at', data?.[0]?.created_at)+` kind=${data?.[0]?.kind}`];
  },
  // propose-templates-to-reps — proposed_to_rep_at
  async () => {
    const { data } = await s.from('email_templates').select('id, proposed_to_rep_at').not('proposed_to_rep_at','is',null).order('proposed_to_rep_at',{ascending:false}).limit(1);
    return ['propose-templates-to-reps (email_templates.proposed_to_rep_at)', fmt('email_templates.proposed_to_rep_at', data?.[0]?.proposed_to_rep_at)];
  },
  // rep-edit-clustering — looks like inserts to email_templates; check created_at across all
  async () => {
    const { data } = await s.from('email_templates').select('id, created_at, source').order('created_at',{ascending:false}).limit(3);
    return ['rep-edit-clustering (latest email_templates inserts)', JSON.stringify(data)];
  },
  // candidate-global-promote — admin_inbox with kind~promote
  async () => {
    const { data } = await s.from('admin_inbox').select('id, created_at, kind').ilike('kind','%promote%').order('created_at',{ascending:false}).limit(1);
    return ['candidate-global-promote (admin_inbox kind~promote)', fmt('admin_inbox.created_at', data?.[0]?.created_at)+` kind=${data?.[0]?.kind}`];
  },
  // template-auto-promote — email_templates promoted_at column?
  async () => {
    const { data } = await s.from('email_templates').select('*').order('created_at',{ascending:false}).limit(1);
    const cols = data?.[0] ? Object.keys(data[0]) : [];
    return ['template-auto-promote (cols sample)', cols.filter(c=>c.includes('promot')||c.includes('active')).join(',') || '(no promote cols)'];
  },
  // insights-realign — insights_snapshots.computed_at
  async () => {
    const { data } = await s.from('insights_snapshots').select('id, computed_at, decided_by').order('computed_at',{ascending:false}).limit(1);
    return ['insights-realign (insights_snapshots.computed_at)', fmt('insights_snapshots.computed_at', data?.[0]?.computed_at)+` by=${data?.[0]?.decided_by}`];
  },
  // insights-prewarm
  async () => {
    const { data } = await s.from('insights_llm_cache').select('id, computed_at, decided_by').order('computed_at',{ascending:false}).limit(1);
    return ['insights-prewarm (insights_llm_cache.computed_at)', fmt('insights_llm_cache.computed_at', data?.[0]?.computed_at)+` by=${data?.[0]?.decided_by}`];
  },
  // daily-rep-brief
  async () => {
    const { data } = await s.from('daily_rep_brief').select('id, computed_at, brief_date').order('computed_at',{ascending:false}).limit(1);
    return ['daily-rep-brief (daily_rep_brief.computed_at)', fmt('daily_rep_brief.computed_at', data?.[0]?.computed_at)+` for=${data?.[0]?.brief_date}`];
  },
  // congress-topic-propose
  async () => {
    const { data } = await s.from('congress_debate_proposals').select('id, created_at').order('created_at',{ascending:false}).limit(1);
    return ['congress-topic-propose (congress_debate_proposals.created_at)', fmt('congress_debate_proposals.created_at', data?.[0]?.created_at)];
  },
  // model-bench-eval
  async () => {
    const { data } = await s.from('model_predictions').select('id, predicted_at, kind').order('predicted_at',{ascending:false}).limit(1);
    return ['model-bench-eval (model_predictions.predicted_at)', fmt('model_predictions.predicted_at', data?.[0]?.predicted_at)+` kind=${data?.[0]?.kind}`];
  },
  // missions/heuristic-seed
  async () => {
    const { data } = await s.from('missions').select('id, created_at').order('created_at',{ascending:false}).limit(1);
    return ['missions/heuristic-seed (missions.created_at)', fmt('missions.created_at', data?.[0]?.created_at)];
  },
  // missions/allocate-leads
  async () => {
    const { data } = await s.from('allocation_log').select('id, created_at, allocator').order('created_at',{ascending:false}).limit(1);
    return ['missions/allocate-leads (allocation_log.created_at)', fmt('allocation_log.created_at', data?.[0]?.created_at)+` by=${data?.[0]?.allocator}`];
  },
  // onboarding-quota-check
  async () => {
    // rep_daily_quotas_override is empty — try rep_daily_quotas
    const { data } = await s.from('rep_daily_quotas').select('*').order('quota_date',{ascending:false}).limit(1);
    const cols = data?.[0] ? Object.keys(data[0]).join(',') : '(empty)';
    return ['onboarding-quota-check (rep_daily_quotas latest)', cols + ' | ' + JSON.stringify(data?.[0]||{}).slice(0,200)];
  },
  // enrich-h-index — pipeline_leads with h_index not null
  async () => {
    const { data } = await s.from('pipeline_leads').select('id, created_at, h_index').not('h_index','is',null).order('created_at',{ascending:false}).limit(1);
    return ['enrich-h-index (pipeline_leads with h_index not null)', fmt('pipeline_leads.created_at', data?.[0]?.created_at)+` h=${data?.[0]?.h_index}`];
  },
  // congress/jitr-tick
  async () => {
    const { data } = await s.from('jitr_offers').select('id, offered_at').order('offered_at',{ascending:false}).limit(1);
    return ['congress/jitr-tick (jitr_offers.offered_at)', fmt('jitr_offers.offered_at', data?.[0]?.offered_at)];
  },
  // congress/weekly
  async () => {
    const { data } = await s.from('tactical_proposals').select('id, proposed_at, title').order('proposed_at',{ascending:false}).limit(1);
    return ['congress/weekly (tactical_proposals.proposed_at)', fmt('tactical_proposals.proposed_at', data?.[0]?.proposed_at)+` t=${data?.[0]?.title?.slice(0,40)}`];
  },
  // congress/monthly
  async () => {
    const { data } = await s.from('strategic_decisions').select('id, decided_at, title').order('decided_at',{ascending:false}).limit(1);
    return ['congress/monthly (strategic_decisions.decided_at)', fmt('strategic_decisions.decided_at', data?.[0]?.decided_at)+` t=${data?.[0]?.title?.slice(0,40)}`];
  },
  // congress/postmortem-detect — sends DM only on threshold breach; can't easily measure. Check admin_inbox kind?
  async () => {
    const { data } = await s.from('admin_inbox').select('id, created_at, kind').ilike('kind','%postmortem%').order('created_at',{ascending:false}).limit(1);
    return ['congress/postmortem-detect (admin_inbox kind~postmortem)', fmt('admin_inbox.created_at', data?.[0]?.created_at)+` kind=${data?.[0]?.kind||'(no rows)'}`];
  },
  // congress-chime
  async () => {
    const { data } = await s.from('helper_chime_in_log').select('id, pushed_at, kind').order('pushed_at',{ascending:false}).limit(1);
    return ['congress-chime (helper_chime_in_log.pushed_at)', fmt('helper_chime_in_log.pushed_at', data?.[0]?.pushed_at)+` kind=${data?.[0]?.kind}`];
  },
  // pipeline/scan-fanout — pipeline_leads
  async () => {
    const { data } = await s.from('pipeline_leads').select('id, created_at').order('created_at',{ascending:false}).limit(1);
    return ['pipeline/scan-fanout (pipeline_leads.created_at)', fmt('pipeline_leads.created_at', data?.[0]?.created_at)];
  },
];

function fmt(label, ts) {
  if (!ts) return `${label}=(no rows)`;
  const ageH = ((now - new Date(ts)) / 3600000).toFixed(1);
  return `${label}=${ts} (${ageH}h ago)`;
}

const results = await Promise.all(fns.map(f => f().catch(e => ['err', String(e).slice(0,120)])));
for (const [l, r] of results) console.log(`[${l}]\n  => ${r}\n`);
