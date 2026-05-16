import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data } = await s.from('lark_messages').select('id, created_at, role, text').eq('role','system').order('created_at',{ascending:false}).limit(5);
console.log('lark_messages role=system (standup admin reports):', data?.map(r=>({at:r.created_at, snippet:r.text?.slice(0,100)})));
