import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
// pipeline_leads counts grouped by source/date
const { data } = await s.from('pipeline_leads').select('source, created_at').gte('created_at','2026-05-15').order('created_at',{ascending:false}).limit(20);
console.log('recent pipeline_leads (last 24-48h):', data?.map(r=>({at:r.created_at, source:r.source})));
// Distinct sources
const all = await s.from('pipeline_leads').select('source').gte('created_at','2026-05-10');
const counts = {};
for (const r of (all.data||[])) counts[r.source||'(null)'] = (counts[r.source||'(null)']||0)+1;
console.log('source distribution last 6d:', counts);
