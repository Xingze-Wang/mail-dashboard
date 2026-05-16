import fs from 'fs';
const env = fs.readFileSync('/Users/xingzewang/Desktop/mail/.env.local', 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/); if (m) process.env[m[1]] = m[2]; }
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// rep_daily_quotas — does it have an updated_at? check max updated_at
const { data: rdq } = await s.from('rep_daily_quotas').select('rep_id, updated_at, per_pool').order('updated_at',{ascending:false}).limit(3);
console.log('rep_daily_quotas latest updated_at:', rdq);

// weekly-checkin route — looking for the actual write. Re-read:
// It writes lark_messages too, role=? Let's check the route to see role
// Already grep'd: it writes to lark_messages.insert.
// look for role
import * as fsx from 'fs';
const wc = fsx.readFileSync('/Users/xingzewang/Desktop/mail/src/app/api/cron/weekly-checkin/route.ts','utf8');
const m = wc.match(/role:\s*["'](\w+)["']/);
console.log('weekly-checkin lark_messages role:', m?.[1]);

// And weekly-checkin runs only on Monday 00:55 UTC. Today is Sat. Last Monday was 5/11. Did it run then?
const { data: wkly } = await s.from('lark_messages').select('id, created_at, role, text').gte('created_at','2026-05-11').lte('created_at','2026-05-11T23:59:59').order('created_at',{ascending:false}).limit(10);
console.log('lark_messages on Mon 5/11:', wkly?.map(r=>({at:r.created_at, role:r.role, snippet:r.text?.slice(0,80)})));

// model-bench-eval — schedule daily 8:00 UTC; last predicted_at = 5/14 (2d ago). Was 5/15 8am UTC missed?
const since3d = '2026-05-14T00:00:00Z';
const { count } = await s.from('model_predictions').select('*', { count:'exact', head:true }).gte('predicted_at', since3d);
console.log('model_predictions since 5/14:', count);

// congress-chime — only fires Mon 7:30 UTC; last Mon was 5/11. helper_chime_in_log shows 5/11 — that matches.
// congress/weekly Mon 1:00 — last Mon 5/11; tactical_proposals proposed_at last 5/4. Did 5/11 weekly run produce nothing? Possible (no signals).
// Let me check curriculum_miner and db_write_digest target tables
const since24 = new Date(Date.now()-86400000).toISOString();
const { count: cm } = await s.from('curriculum_modules').select('*', { count:'exact', head:true }).catch(()=>({count:null}));
console.log('curriculum_modules total:', cm);
