import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// email_templates schema
const { data: et, error: etErr } = await s.from('email_templates').select('*').limit(1);
console.log('email_templates one row error:', etErr?.message);
console.log('email_templates one row cols:', et?.[0] ? Object.keys(et[0]).join(',') : '(empty)');

// All inserts to email_templates last 30 days
const since30 = new Date(Date.now()-30*86400000).toISOString();
const { data: recents, error: recErr } = await s.from('email_templates').select('id, name, created_at').gte('created_at', since30).order('created_at',{ascending:false}).limit(10);
console.log('email_templates last 30d:', recErr?.message, recents);

// standup writes to lark_messages with role=?
const { data: stand } = await s.from('lark_messages').select('id, created_at, role, text').gte('created_at', new Date(Date.now()-3*86400000).toISOString()).order('created_at',{ascending:false}).limit(15);
console.log('lark_messages last 3d:', stand?.map(r=>({id:r.id, at:r.created_at, role:r.role, snippet:r.text?.slice(0,80)})));

// Check standup route to see exact insert
// Also check helper_chime_in_log size
const { count: chimeCount } = await s.from('helper_chime_in_log').select('*', { count:'exact', head:true });
console.log('helper_chime_in_log total rows:', chimeCount);
