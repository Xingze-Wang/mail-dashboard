import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Get one row from each schema-uncertain table to identify columns.
const tables = ['lark_messages','insights_snapshots','insights_llm_cache','daily_rep_brief','model_predictions','pipeline_leads','tactical_proposals','strategic_decisions','helper_chime_in_log','allocation_log','jitr_offers','rep_daily_quotas_override'];
for (const t of tables) {
  const { data, error } = await s.from(t).select('*').limit(1);
  if (error) { console.log(`[${t}] ERR ${error.message}`); continue; }
  if (!data || data.length === 0) { console.log(`[${t}] EMPTY`); continue; }
  console.log(`[${t}] cols=${Object.keys(data[0]).join(',')}`);
}
