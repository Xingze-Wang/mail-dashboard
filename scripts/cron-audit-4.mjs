import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Get all distinct kinds from admin_inbox and helper_chime_in_log recently
const { data: kinds } = await s.from('admin_inbox').select('kind, created_at').order('created_at',{ascending:false}).limit(20);
console.log('admin_inbox recent kinds:', kinds);
const { data: chimes } = await s.from('helper_chime_in_log').select('kind, pushed_at').order('pushed_at',{ascending:false}).limit(20);
console.log('helper_chime_in_log recent kinds:', chimes);

// Check rep_daily_quotas latest
const { data: rdq } = await s.from('rep_daily_quotas').select('*').limit(5);
console.log('rep_daily_quotas sample:', rdq);

// Check email_templates source col for clustering
const { data: et } = await s.from('email_templates').select('id, name, created_at, status, scope_kind, active').order('created_at',{ascending:false}).limit(8);
console.log('email_templates recent:', et);

// Check lark_messages with role=bot to see standup-ish messages
const { data: lm } = await s.from('lark_messages').select('id, created_at, role, text').eq('role','bot').order('created_at',{ascending:false}).limit(8);
console.log('lark_messages bot recent:', lm?.map(r=>({id:r.id, at:r.created_at, snippet:r.text?.slice(0,100)})));

// Last 24h pipeline_leads count
const since = new Date(Date.now()-86400000).toISOString();
const { count } = await s.from('pipeline_leads').select('*', { count:'exact', head:true }).gte('created_at', since);
console.log('pipeline_leads last 24h count:', count);

// model_predictions by model_bench kind
const { data: mp } = await s.from('model_predictions').select('kind, predicted_at, llm_model').order('predicted_at',{ascending:false}).limit(5);
console.log('model_predictions latest:', mp);

// daily_rep_brief — see last few
const { data: drb } = await s.from('daily_rep_brief').select('rep_id, brief_date, computed_at').order('computed_at',{ascending:false}).limit(5);
console.log('daily_rep_brief recent:', drb);
