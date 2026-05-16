import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
// Latest pipeline_leads NOT from python_scanner (these would be from master /api/cron's scanArxiv)
const { data } = await s.from('pipeline_leads').select('id, source, created_at').neq('source','python_scanner').not('source','is',null).order('created_at',{ascending:false}).limit(5);
console.log('non-python_scanner latest pipeline_leads:', data);
// Also nullSource
const { data: nullSrc } = await s.from('pipeline_leads').select('id, source, created_at').is('source',null).order('created_at',{ascending:false}).limit(5);
console.log('null-source latest pipeline_leads:', nullSrc);
