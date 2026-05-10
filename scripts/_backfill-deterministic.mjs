/**
 * Deterministic backfill — no agents, no LLM. Three passes:
 *
 *   1. school_tier from email domain (via SCHOOL_DATA mirror).
 *      The S2 enrichment agents wrote school_name but skipped tier;
 *      retroactively fill it from a known-domains table.
 *
 *   2. school_tier from school_name (fuzzy domain reverse-lookup).
 *      Some leads have school_name="Tsinghua University" but no tier.
 *      Look up the tier from the canonical name.
 *
 *   3. matched_directions from arxiv_id via paper_authors join.
 *      paper_authors has matched_directions per paper from the original
 *      scanner; copy them across to leads where missing.
 *
 * Runs once, idempotent. Updates only when source has data and target
 * is null (never overwrites human-curated).
 */
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// Mirror of src/lib/scanner-config.ts SCHOOL_DATA — kept here so this
// script doesn't need TS imports. Domains → tier (1 = top, 2 = strong, 3 = mid).
// Plus: a NAME → tier table for the school_name reverse lookup.
const DOMAIN_TIER = {
  // Tier 1 (CN top + Hong Kong + Singapore top)
  'tsinghua.edu.cn': 1, 'mails.tsinghua.edu.cn': 1, 'mail.tsinghua.edu.cn': 1, 'tsinghua.org.cn': 1,
  'pku.edu.cn': 1, 'stu.pku.edu.cn': 1, 'mail.pku.edu.cn': 1,
  'zju.edu.cn': 1, 'mail.zju.edu.cn': 1, 'sjtu.edu.cn': 1, 'mail.sjtu.edu.cn': 1, 'apex.sjtu.edu.cn': 1,
  'fudan.edu.cn': 1, 'm.fudan.edu.cn': 1, 'mail.fudan.edu.cn': 1,
  'ustc.edu.cn': 1, 'mail.ustc.edu.cn': 1, 'mails.ucas.ac.cn': 1, 'ucas.ac.cn': 1,
  'nju.edu.cn': 1, 'mails.nju.edu.cn': 1, 'sustech.edu.cn': 1, 'mail.sustech.edu.cn': 1,
  'cuhk.edu.hk': 1, 'cuhk.edu.cn': 1, 'mail.cuhk.edu.cn': 1, 'hku.hk': 1, 'connect.hku.hk': 1,
  'ust.hk': 1, 'connect.ust.hk': 1, 'cse.cuhk.edu.hk': 1, 'comp.polyu.edu.hk': 1, 'connect.polyu.hk': 1,
  'cityu.edu.hk': 1, 'connect.cityu.edu.hk': 1, 'eduhk.hk': 1,
  'nus.edu.sg': 1, 'u.nus.edu': 1, 'comp.nus.edu.sg': 1, 'ntu.edu.sg': 1, 'e.ntu.edu.sg': 1,
  // US elite
  'mit.edu': 1, 'csail.mit.edu': 1, 'media.mit.edu': 1,
  'stanford.edu': 1, 'cs.stanford.edu': 1, 'ee.stanford.edu': 1,
  'berkeley.edu': 1, 'cs.berkeley.edu': 1, 'eecs.berkeley.edu': 1,
  'cmu.edu': 1, 'andrew.cmu.edu': 1, 'cs.cmu.edu': 1,
  'princeton.edu': 1, 'cs.princeton.edu': 1, 'harvard.edu': 1, 'cs.harvard.edu': 1, 'g.harvard.edu': 1,
  'caltech.edu': 1, 'cms.caltech.edu': 1, 'columbia.edu': 1, 'cs.columbia.edu': 1, 'ee.columbia.edu': 1,
  'cornell.edu': 1, 'cs.cornell.edu': 1, 'yale.edu': 1, 'cs.yale.edu': 1, 'ucla.edu': 1, 'cs.ucla.edu': 1,
  // EU + UK + CH
  'ox.ac.uk': 1, 'cs.ox.ac.uk': 1, 'robots.ox.ac.uk': 1, 'cam.ac.uk': 1, 'cl.cam.ac.uk': 1,
  'imperial.ac.uk': 1, 'imperial.com': 1, 'ed.ac.uk': 1, 'epfl.ch': 1, 'ethz.ch': 1, 'inf.ethz.ch': 1,
  'tum.de': 1, 'in.tum.de': 1,
  // Tier 2 (CN strong + EU mid)
  'bjtu.edu.cn': 2, 'bupt.edu.cn': 2, 'buaa.edu.cn': 2, 'bit.edu.cn': 2, 'tongji.edu.cn': 2,
  'whu.edu.cn': 2, 'mail.whu.edu.cn': 2, 'hust.edu.cn': 2, 'mail.hust.edu.cn': 2,
  'xjtu.edu.cn': 2, 'mail.xjtu.edu.cn': 2, 'stu.xjtu.edu.cn': 2,
  'uestc.edu.cn': 2, 'std.uestc.edu.cn': 2, 'mail.uestc.edu.cn': 2, 'cqu.edu.cn': 2,
  'scu.edu.cn': 2, 'nwpu.edu.cn': 2, 'mail.nwpu.edu.cn': 2, 'hit.edu.cn': 2, 'stu.hit.edu.cn': 2,
  'shu.edu.cn': 2, 'ouc.edu.cn': 2, 'lzu.edu.cn': 2, 'jlu.edu.cn': 2, 'sdu.edu.cn': 2,
  'cqupt.edu.cn': 2, 'shanghaitech.edu.cn': 2, 'shanghaitech.edu.cn': 2,
  'ruc.edu.cn': 2, 'mail.ruc.edu.cn': 2, 'mails.ruc.edu.cn': 2,
  'sysu.edu.cn': 2, 'mail.sysu.edu.cn': 2, 'mail2.sysu.edu.cn': 2,
  'xidian.edu.cn': 2, 'mail.xidian.edu.cn': 2, 'stu.xidian.edu.cn': 2,
  'ecnu.edu.cn': 2, 'cs.ecnu.edu.cn': 2, 'stu.ecnu.edu.cn': 2,
  'csu.edu.cn': 2, 'tju.edu.cn': 2, 'nankai.edu.cn': 2, 'cau.edu.cn': 2,
  'seu.edu.cn': 2, 'smail.seu.edu.cn': 2, 'mail.dlut.edu.cn': 2, 'dlut.edu.cn': 2,
  'szu.edu.cn': 2, 'mail.szu.edu.cn': 2, 'cup.edu.cn': 2,
  'hfut.edu.cn': 2, 'mail.hfut.edu.cn': 2, 'gdut.edu.cn': 2, 'mails.gdut.edu.cn': 2,
  'umd.edu': 2, 'cs.umd.edu': 2, 'umich.edu': 2, 'eecs.umich.edu': 2, 'cs.umich.edu': 2,
  'gatech.edu': 2, 'cc.gatech.edu': 2, 'usc.edu': 2, 'cs.usc.edu': 2, 'ucsd.edu': 2,
  'cs.ucsd.edu': 2, 'utexas.edu': 2, 'cs.utexas.edu': 2, 'illinois.edu': 2, 'cs.illinois.edu': 2,
  'wisc.edu': 2, 'cs.wisc.edu': 2, 'duke.edu': 2, 'cs.duke.edu': 2, 'jhu.edu': 2, 'cs.jhu.edu': 2,
  'kcl.ac.uk': 2, 'ucl.ac.uk': 2, 'cs.ucl.ac.uk': 2, 'manchester.ac.uk': 2, 'postgrad.manchester.ac.uk': 2,
  'kit.edu': 2, 'kuleuven.be': 2, 'tudelft.nl': 2, 'tue.nl': 2,
  'monash.edu': 2, 'unimelb.edu.au': 2, 'sydney.edu.au': 2, 'uni.sydney.edu.au': 2,
  'kaist.ac.kr': 2, 'snu.ac.kr': 2, 'postech.ac.kr': 2,
  'pjlab.org.cn': 2, 'iie.ac.cn': 2, 'ia.ac.cn': 2, 'nlpr.ia.ac.cn': 2, 'aircas.ac.cn': 2,
  'ict.ac.cn': 2, 'iscas.ac.cn': 2, 'iee.ac.cn': 2,
  // Tier 3 (everything else identifiable)
  'nwu.edu.cn': 3, 'sxu.edu.cn': 3, 'cumt.edu.cn': 3, 'ynu.edu.cn': 3, 'gzhu.edu.cn': 3,
  'sxnu.edu.cn': 3, 'jnu.edu.cn': 3, 'shnu.edu.cn': 3, 'smail.shnu.edu.cn': 3,
  'cpu.edu.cn': 3, 'std.cpu.edu.cn': 3, 'sustc.edu.cn': 3, 'njust.edu.cn': 3,
  'nuaa.edu.cn': 3, 'cust.edu.cn': 3, 'hrbeu.edu.cn': 3, 'hrbust.edu.cn': 3,
  'sufe.edu.cn': 3, 'swufe.edu.cn': 3, 'shu.edu.cn': 3, 'tongji.edu.cn': 3,
};
const NAME_TIER_PATTERNS = [
  // Top
  [/tsinghua/i, 1], [/peking|^pku/i, 1], [/zhejiang/i, 1], [/shanghai jiao\s?tong|sjtu/i, 1],
  [/fudan/i, 1], [/ustc|university of science and tech/i, 1], [/nanjing|^nju/i, 1],
  [/sustech|southern university of science/i, 1],
  [/chinese university of hong kong|cuhk/i, 1], [/university of hong kong|^hku/i, 1],
  [/^hk\s?ust|hong kong university of science/i, 1], [/national university of singapore|^nus/i, 1],
  [/nanyang technological|^ntu\b/i, 1], [/^mit\b|massachusetts institute/i, 1],
  [/stanford/i, 1], [/berkeley|uc berkeley/i, 1], [/carnegie mellon|^cmu\b/i, 1],
  [/princeton/i, 1], [/harvard/i, 1], [/caltech|california institute/i, 1],
  [/columbia university/i, 1], [/cornell/i, 1], [/yale/i, 1], [/ucla/i, 1],
  [/oxford/i, 1], [/cambridge/i, 1], [/imperial college/i, 1], [/edinburgh/i, 1],
  [/epfl/i, 1], [/eth zurich|^eth\b/i, 1], [/^tum\b|technical university of munich/i, 1],
  // Strong
  [/beihang|^buaa/i, 2], [/beijing institute of tech|^bit\b/i, 2], [/tongji/i, 2],
  [/wuhan university/i, 2], [/huazhong/i, 2], [/xi'?an jiaotong|^xjtu/i, 2],
  [/uestc|electronic science and tech/i, 2], [/chongqing/i, 2], [/sichuan/i, 2],
  [/northwestern polytech|^nwpu/i, 2], [/harbin institute|^hit\b/i, 2],
  [/shanghai\s?university|^shu\b/i, 2], [/jilin/i, 2], [/shandong/i, 2],
  [/renmin\s?university|^ruc\b|人民大学/i, 2], [/sun yat-?sen|^sysu/i, 2],
  [/xidian/i, 2], [/east china normal|^ecnu/i, 2], [/central south|^csu\b/i, 2],
  [/tianjin|^tju\b/i, 2], [/nankai/i, 2], [/southeast university|^seu\b/i, 2],
  [/dalian/i, 2], [/shenzhen|^szu\b/i, 2],
  [/hefei|^hfut\b/i, 2], [/guangdong/i, 2],
  [/maryland|umd/i, 2], [/^michigan|umich/i, 2], [/georgia tech/i, 2],
  [/southern california|^usc\b/i, 2], [/^uc san diego|ucsd/i, 2],
  [/texas\s?austin|ut austin/i, 2], [/illinois|uiuc|urbana/i, 2],
  [/wisconsin/i, 2], [/duke/i, 2], [/johns hopkins/i, 2],
  [/king'?s college/i, 2], [/^ucl\b|university college london/i, 2], [/manchester/i, 2],
  [/karlsruhe|^kit\b/i, 2], [/leuven/i, 2], [/delft/i, 2], [/eindhoven|^tue\b/i, 2],
  [/monash/i, 2], [/melbourne/i, 2], [/sydney/i, 2],
  [/kaist|korea advanced/i, 2], [/seoul national/i, 2], [/^postech\b/i, 2],
  [/peng cheng|pcl/i, 2], [/iie|institute of information engineering/i, 2],
  [/automation.*chinese academy|chinese academy of sciences|^cas\b|^iscas/i, 2],
  // Mid (catchall for known-but-not-elite)
  [/yunnan/i, 3], [/lanzhou/i, 3], [/jinan|^jnu\b/i, 3], [/shanghai normal/i, 3],
  [/china pharmaceutical/i, 3], [/communications/i, 3],
];
function getTierFromDomain(email) {
  const dom = (email||'').toLowerCase().split('@')[1];
  if (!dom) return null;
  if (DOMAIN_TIER[dom]) return DOMAIN_TIER[dom];
  // Try parent domains: stu.xidian.edu.cn → xidian.edu.cn
  const parts = dom.split('.');
  for (let i = 1; i <= 2; i++) {
    const partial = parts.slice(i).join('.');
    if (DOMAIN_TIER[partial]) return DOMAIN_TIER[partial];
  }
  return null;
}
function getTierFromName(name) {
  if (!name) return null;
  for (const [pattern, tier] of NAME_TIER_PATTERNS) {
    if (pattern.test(name)) return tier;
  }
  return null;
}

(async () => {
  // Pull all leads
  let leads = [], cur = 0;
  while (true) {
    const { data } = await sb.from('pipeline_leads').select('id, arxiv_id, author_email, school_name, school_tier, matched_directions').range(cur, cur+999);
    if (!data || data.length === 0) break;
    leads.push(...data);
    if (data.length < 1000) break;
    cur += 1000;
  }
  console.log(`loaded ${leads.length} leads`);

  // PASS 1: school_tier from domain
  let pass1 = 0;
  for (const l of leads) {
    if (l.school_tier != null) continue;
    const tier = getTierFromDomain(l.author_email);
    if (tier == null) continue;
    const { error } = await sb.from('pipeline_leads').update({ school_tier: tier }).eq('id', l.id);
    if (!error) { pass1++; l.school_tier = tier; }
  }
  console.log(`PASS 1 (domain → tier): ${pass1} leads updated`);

  // PASS 2: school_tier from school_name
  let pass2 = 0;
  for (const l of leads) {
    if (l.school_tier != null) continue;
    const tier = getTierFromName(l.school_name);
    if (tier == null) continue;
    const { error } = await sb.from('pipeline_leads').update({ school_tier: tier }).eq('id', l.id);
    if (!error) { pass2++; l.school_tier = tier; }
  }
  console.log(`PASS 2 (name → tier): ${pass2} leads updated`);

  // PASS 3: matched_directions from paper_authors join
  // paper_authors stores per-paper directions; copy when lead has none.
  const arxivIds = leads.filter(l => l.arxiv_id && (!l.matched_directions || (Array.isArray(l.matched_directions) && l.matched_directions.length === 0))).map(l => l.arxiv_id);
  // Some matched_directions are stored as JSON-string; treat empty-string and "[]" as missing too
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
  console.log(`PASS 3 candidates: ${noDir.length} leads need directions`);

  // Pull paper_authors directions chunked
  const aIds = [...new Set(noDir.map(l => l.arxiv_id))];
  const dirByArxiv = new Map();
  // paper_authors has matched_directions per row keyed by arxiv_id+author; pick any non-empty
  const CH = 200;
  for (let i = 0; i < aIds.length; i += CH) {
    const chunk = aIds.slice(i, i+CH);
    const { data } = await sb.from('paper_authors').select('arxiv_id, matched_directions').in('arxiv_id', chunk);
    for (const r of data ?? []) {
      const m = r.matched_directions;
      if (!m) continue;
      const arr = Array.isArray(m) ? m : (() => { try { const p = JSON.parse(m); return Array.isArray(p) ? p : null; } catch { return null; } })();
      if (arr && arr.length > 0 && !dirByArxiv.has(r.arxiv_id)) dirByArxiv.set(r.arxiv_id, arr);
    }
  }
  let pass3 = 0;
  for (const l of noDir) {
    const dirs = dirByArxiv.get(l.arxiv_id);
    if (!dirs) continue;
    const { error } = await sb.from('pipeline_leads').update({ matched_directions: dirs }).eq('id', l.id);
    if (!error) pass3++;
  }
  console.log(`PASS 3 (arxiv → directions): ${pass3} leads updated`);

  // FINAL: re-count
  const all = await sb.from('pipeline_leads').select('id', {count:'exact', head:true});
  const noT = await sb.from('pipeline_leads').select('id', {count:'exact', head:true}).is('school_tier', null);
  const noD = await sb.from('pipeline_leads').select('id', {count:'exact', head:true}).or('matched_directions.is.null,matched_directions.eq.[]');
  const noH = await sb.from('pipeline_leads').select('id', {count:'exact', head:true}).is('h_index', null);
  const noC = await sb.from('pipeline_leads').select('id', {count:'exact', head:true}).is('citation_count', null);
  console.log(`\nFINAL state (${all.count} leads):`);
  console.log(`  missing school_tier: ${noT.count} (${(noT.count/all.count*100).toFixed(1)}%)`);
  console.log(`  missing directions:  ${noD.count} (${(noD.count/all.count*100).toFixed(1)}%)`);
  console.log(`  missing h_index:     ${noH.count} (${(noH.count/all.count*100).toFixed(1)}%)`);
  console.log(`  missing citation:    ${noC.count} (${(noC.count/all.count*100).toFixed(1)}%)`);
})();
