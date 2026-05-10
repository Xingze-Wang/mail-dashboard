/**
 * Backfill matched_directions from arxiv API categories.
 *
 * arxiv abs response includes <category term="cs.CV"> tags. Map those
 * to our research-direction taxonomy. One API call per arxiv_id with
 * 4s rate limit (well below arxiv's 1 req/3s soft cap so single
 * sequential process won't trigger their ban).
 *
 * Idempotent: only updates rows where matched_directions is null/[].
 */
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// arxiv category → research direction (Chinese, matches our existing taxonomy).
// Multi-category papers get multiple directions.
const CATEGORY_MAP = {
  'cs.CV':  '多模态内容解析',
  'cs.CL':  '语言模型',
  'cs.LG':  '机器学习',
  'cs.AI':  'AI Agents',
  'cs.RO':  '具身智能',
  'cs.GR':  '3D资产生成',
  'cs.MM':  '多模态内容解析',
  'cs.SD':  '语音模型',
  'eess.AS':'语音模型',
  'cs.IR':  '推荐系统',
  'cs.HC':  '人机交互',
  'cs.SE':  'Coding Agent',
  'cs.PL':  'Coding Agent',
  'cs.CR':  'AI 安全',
  'cs.NE':  '神经网络架构',
  'cs.DC':  '分布式推理架构',
  'cs.AR':  '硬件感知优化',
  'cs.NI':  '网络与通信',
  'eess.SY':'控制系统',
  'eess.IV':'图像处理',
  'eess.SP':'信号处理',
  'stat.ML':'机器学习',
  'q-bio.QM':'生物信息',
  'q-bio.NC':'神经科学',
  'physics.med-ph':'医学物理',
  'physics.comp-ph':'计算物理',
  'math.OC':'优化',
  'math.NA':'数值分析',
  'math.ST':'统计',
  'cs.IT':  '信息论',
  'cs.GT':  '博弈论与多智能体',
  'cs.MA':  '博弈论与多智能体',
  'cs.SY':  '控制系统',
  'cs.DS':  '算法',
  'cs.CC':  '复杂性理论',
  'cs.LO':  '逻辑与形式化',
  'cs.PF':  '性能优化',
  'cs.OS':  '操作系统',
  'cs.DB':  '数据库',
  'cs.SC':  '符号计算',
};

async function fetchArxiv(arxivId) {
  // Use export.arxiv.org id_list for exact-match lookup. https-direct.
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  if (r.status === 429) {
    throw Object.assign(new Error('arxiv rate limited'), { code: 'RATE_LIMIT' });
  }
  if (!r.ok) return null;
  const xml = await r.text();
  // Extract <category term="..."> tags
  const cats = [...xml.matchAll(/<category[^>]*term="([^"]+)"/g)].map(m => m[1]);
  // Extract title for safety
  const titleMatch = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
  const title = (titleMatch?.[1] || '').replace(/\s+/g, ' ').trim();
  return { title, categories: cats };
}

(async () => {
  // Pull leads needing directions
  let leads = [], cur = 0;
  while (true) {
    const { data } = await sb.from('pipeline_leads').select('id, arxiv_id, matched_directions').range(cur, cur+999);
    if (!data || data.length === 0) break;
    leads.push(...data);
    if (data.length < 1000) break;
    cur += 1000;
  }
  const noDir = leads.filter(l => {
    if (!l.arxiv_id) return false;
    const m = l.matched_directions;
    if (m == null) return true;
    if (Array.isArray(m)) return m.length === 0;
    if (typeof m === 'string') {
      const t = m.trim();
      return t === '' || t === '[]' || t === '{}';
    }
    return false;
  });
  console.log(`${noDir.length} leads need directions backfilled from arxiv`);

  let okCount = 0, missCount = 0, errCount = 0, rateBackoff = 0;
  for (let i = 0; i < noDir.length; i++) {
    const lead = noDir[i];
    if (rateBackoff > 0) {
      console.log(`  [backoff] sleeping ${rateBackoff}s after rate limit`);
      await new Promise(r => setTimeout(r, rateBackoff * 1000));
      rateBackoff = 0;
    }
    try {
      const meta = await fetchArxiv(lead.arxiv_id);
      if (!meta) { missCount++; continue; }
      // Map categories → directions, dedupe
      const dirs = [...new Set(meta.categories.map(c => CATEGORY_MAP[c]).filter(Boolean))];
      if (dirs.length === 0) { missCount++; continue; }
      const updates = { matched_directions: dirs };
      const { error } = await sb.from('pipeline_leads').update(updates).eq('id', lead.id);
      if (error) { errCount++; console.log(`  err: ${error.message}`); }
      else {
        okCount++;
        if (okCount % 50 === 0) console.log(`  [${okCount}/${noDir.length}] ${lead.arxiv_id} → ${dirs.slice(0,2).join(', ')}`);
      }
    } catch (e) {
      errCount++;
      if (e.code === 'RATE_LIMIT') {
        rateBackoff = Math.min(120, (rateBackoff || 15) * 2);
        console.log(`  rate limit hit, backoff ${rateBackoff}s`);
      } else {
        console.log(`  err: ${e.message}`);
      }
    }
    // arxiv unwritten rule: 1 req per 3s; we use 4s for safety.
    await new Promise(r => setTimeout(r, 4000));
  }
  console.log(`\nDONE: ${okCount} updated, ${missCount} no-data, ${errCount} errors`);
})();
