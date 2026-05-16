import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
// daily_rep_brief history
const { data } = await s.from('daily_rep_brief').select('rep_id, brief_date, computed_at').order('computed_at',{ascending:false}).limit(30);
console.log('daily_rep_brief history (last 30):');
for (const r of (data||[])) console.log(`  rep=${r.rep_id} for=${r.brief_date} computed=${r.computed_at}`);
