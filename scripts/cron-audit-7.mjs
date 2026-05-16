import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Look for any weekly-checkin role=system message ever (containing 上周 or 本周)
const { data } = await s.from('lark_messages').select('id, created_at, text').eq('role','system').or('text.ilike.%上周%,text.ilike.%本周%,text.ilike.%checkin%').order('created_at',{ascending:false}).limit(5);
console.log('weekly-checkin candidates:', data?.map(r=>({at:r.created_at, snip:r.text?.slice(0,120)})));

// also raw count system messages last 14 days
const { count: sysCount } = await s.from('lark_messages').select('*', { count:'exact', head:true }).eq('role','system').gte('created_at','2026-05-02');
console.log('lark_messages role=system since 5/02:', sysCount);

// list all distinct system snippets in last 14d
const { data: allSys } = await s.from('lark_messages').select('id, created_at, text').eq('role','system').gte('created_at','2026-05-02').order('created_at',{ascending:false});
console.log('all system msgs:', allSys?.map(r=>({at:r.created_at, snip:r.text?.slice(0,80)})));

// also check whether stuck-rep-alarm, db-write-digest, inbox-auto-archive, curriculum-miner have ever run
// They're called via fan-out, so they would have written something if working.
// stuck-rep-alarm -> probably writes lark_messages or admin_inbox
// db-write-digest -> admin_inbox? lark
// inbox-auto-archive -> updates admin_inbox.status
// curriculum-miner -> writes ??

// Check admin_inbox for any kind = curriculum / digest / stuck
const { data: kinds } = await s.from('admin_inbox').select('kind').gte('created_at','2026-05-01');
const kindSet = new Set();
for (const r of (kinds||[])) kindSet.add(r.kind);
console.log('admin_inbox distinct kinds since 5/01:', [...kindSet]);

// Check sales_reps for d7 ever non-null
const { data: d7s } = await s.from('sales_reps').select('id, name, followup_d7_sent_at').not('followup_d7_sent_at','is',null).limit(3);
console.log('followup_d7 set on reps:', d7s);
