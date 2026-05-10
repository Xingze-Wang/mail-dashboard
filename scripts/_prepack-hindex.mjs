import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function fetchArxiv(arxivId) {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (r.status === 429) throw Object.assign(new Error('arxiv 429'), { code: 'RATE_LIMIT' });
  if (!r.ok) return null;
  const xml = await r.text();
  const titleMatch = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
  const title = (titleMatch?.[1] || '').replace(/\s+/g, ' ').trim();
  const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
  const abstract = (summaryMatch?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const authors = [];
  const authorRegex = /<author>([\s\S]*?)<\/author>/g;
  let m;
  while ((m = authorRegex.exec(xml)) !== null) {
    const block = m[1];
    const nameM = block.match(/<name>([\s\S]*?)<\/name>/);
    const affM = block.match(/<arxiv:affiliation>([\s\S]*?)<\/arxiv:affiliation>/);
    if (nameM) {
      authors.push({
        name: nameM[1].replace(/\s+/g, ' ').trim(),
        affiliation: affM ? affM[1].replace(/\s+/g, ' ').trim() : null,
      });
    }
  }
  return { title, abstract, authors };
}

function matchAuthor(email, authors) {
  if (!email || !authors || authors.length === 0) return null;
  const local = email.split('@')[0].toLowerCase();
  const parts = local.split(/[._-]/).filter(p => /[a-z]/.test(p));
  if (parts.length === 0) return null;
  if (parts.length >= 2) {
    const first = parts[0], last = parts[parts.length - 1];
    for (const a of authors) {
      const tokens = a.name.toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const aLast = tokens[tokens.length - 1];
      const aFirst = tokens[0];
      if (aLast === last && (aFirst === first || aFirst[0] === first[0])) return a;
    }
  }
  for (const a of authors) {
    const tokens = a.name.toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (t === local) return a;
    }
  }
  const stripped = local.replace(/[0-9]+$/, '');
  if (stripped.length >= 3) {
    for (const a of authors) {
      const tokens = a.name.toLowerCase().split(/\s+/).filter(Boolean);
      const last = tokens[tokens.length - 1];
      if (stripped.endsWith(last) && stripped.length === last.length + 1) {
        const expectedInitial = stripped[0];
        if (tokens[0][0] === expectedInitial) return a;
      }
      if (stripped === last) return a;
    }
  }
  return null;
}

function summarize(lead) {
  return {
    lead_id: lead.id,
    arxiv_id: lead.arxiv_id,
    recipient: lead.author_email,
    school_name: lead.school_name,
    existing_citation_count: lead.citation_count,
  };
}

(async () => {
  let leads = [], cur = 0;
  while (true) {
    const { data } = await sb.from('pipeline_leads').select('id, arxiv_id, author_email, school_name, h_index, citation_count').range(cur, cur + 999);
    if (!data || data.length === 0) break;
    leads.push(...data);
    if (data.length < 1000) break;
    cur += 1000;
  }
  const targets = leads.filter(l => l.h_index == null && l.arxiv_id);
  console.log(`${targets.length} leads need h_index pre-pack`);

  const tasks = [];
  let okCount = 0, missCount = 0, errCount = 0, rateBackoff = 0;
  for (let i = 0; i < targets.length; i++) {
    const lead = targets[i];
    if (rateBackoff > 0) {
      await new Promise(r => setTimeout(r, rateBackoff * 1000));
      rateBackoff = 0;
    }
    try {
      const meta = await fetchArxiv(lead.arxiv_id);
      if (!meta) { missCount++; tasks.push({ ...summarize(lead), arxiv_meta: null }); continue; }
      const matched = matchAuthor(lead.author_email, meta.authors);
      tasks.push({
        lead_id: lead.id,
        arxiv_id: lead.arxiv_id,
        recipient: lead.author_email,
        school_name: lead.school_name,
        existing_citation_count: lead.citation_count,
        paper_title: meta.title,
        paper_abstract: meta.abstract,
        all_authors: meta.authors.map(a => a.name).slice(0, 10),
        matched_author: matched?.name ?? null,
        matched_affiliation: matched?.affiliation ?? null,
      });
      okCount++;
      if (okCount % 50 === 0) console.log(`  [${okCount}/${targets.length}] ${lead.arxiv_id} -> ${matched?.name ?? '(no match)'}`);
    } catch (e) {
      errCount++;
      if (e.code === 'RATE_LIMIT') {
        rateBackoff = Math.min(120, (rateBackoff || 15) * 2);
        console.log(`  rate limit hit, backoff ${rateBackoff}s`);
      } else {
        console.log(`  err: ${e.message}`);
      }
      tasks.push({ ...summarize(lead), arxiv_meta: null });
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  console.log(`\nfetched: ${okCount} ok, ${missCount} no-data, ${errCount} errors`);

  const SHARDS = 25;
  const buckets = Array.from({ length: SHARDS }, () => []);
  for (let i = 0; i < tasks.length; i++) buckets[i % SHARDS].push(tasks[i]);
  mkdirSync('/tmp/h-index', { recursive: true });
  for (let i = 0; i < SHARDS; i++) {
    writeFileSync(`/tmp/h-index/shard-${String(i).padStart(2, '0')}.json`, JSON.stringify(buckets[i], null, 2));
  }
  console.log(`Wrote ${SHARDS} shards averaging ${(tasks.length / SHARDS).toFixed(1)} per shard`);
})();
