// Retry the 8 leads from shard-26 that returned s2_paper_http_0 (network).
// Stricter logic this time: require exact_norm or full subset (>= 1.0). Reject partials.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const FIELDS = "title,authors.name,authors.authorId,authors.hIndex,authors.citationCount,authors.paperCount,authors.affiliations";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { id: "fc416983-8983-4345-b801-3671771e5086", name: "Hu He", school: "中南大学", arxiv_id: "2604.17504", paper_title: "RS-HyRe-R1: A Hybrid Reward Mechanism to Overcome Perceptual Inertia for Remote Sensing Images Understanding" },
  { id: "b30345bf-37b7-4147-a9b1-5c815396676e", name: "Zichuan Lin", school: "Tencent Hunyuan", arxiv_id: "2603.24533", paper_title: "UI-Voyager: A Self-Evolving GUI Agent Learning via Failed Experience" },
  { id: "301e398d-4f72-4522-9d9f-c2e7eccdd59b", name: "Haoxu Li", school: "University of Chinese Academy of Sciences", arxiv_id: "2604.15768", paper_title: "cuNNQS-SCI: A Fully GPU-Accelerated Framework for High-Performance Configuration Interaction Selection with Neural Network Quantum States" },
  { id: "cf43cef8-804c-4e39-b077-5080a21f31c4", name: "Chao-Yi Wu", school: "Harvard", arxiv_id: "2605.01616", paper_title: "From Packets to Patterns: Interpreting Encrypted Network Traffic as Longitudinal Behavioral Signals" },
  { id: "24cbbdb9-ce2d-450d-b4f0-4dcf3701e53c", name: "Jianhuang Lai", school: "Sun Yat-sen University", arxiv_id: "2604.19218", paper_title: "Thinking Before Matching: A Reinforcement Reasoning Paradigm Towards General Person Re-Identification" },
  { id: "eeabcb59-953b-4c48-a993-eda690707cab", name: "Weijie Feng", school: "Hefei University of Technology", arxiv_id: "2604.19547", paper_title: "Emotion-Cause Pair Extraction in Conversations via Semantic Decoupling and Graph Alignment" },
  { id: "10264672-d8d1-4e29-af7b-ec386395c186", name: "Geoffrey Ye Li", school: null, arxiv_id: "2604.12931", paper_title: "Token Encoding for Semantic Recovery" },
  { id: "2625435f-335c-423c-83e7-69c5ea9fd630", name: "Prince Zizhuang Wang, Shuli Jiang", school: "Carnegie Mellon University", arxiv_id: "2604.01487", paper_title: "AgentSocialBench: Evaluating Privacy Risks in Human-Centered Agentic Social Networks" },
];

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s) { return new Set(norm(s).split(" ").filter(Boolean)); }
function titleOverlap(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

function pickAuthor(namedRaw, authors) {
  if (!authors?.length) return { match: null, reason: "no_authors_from_s2" };
  const first = (namedRaw || "").split(",")[0].trim();
  const nTokens = tokens(first);
  if (!nTokens.size) return { match: null, reason: "empty_name" };
  for (const a of authors) if (norm(a.name) === norm(first)) return { match: a, reason: "exact_norm" };
  for (const a of authors) {
    const aTokens = tokens(a.name);
    let hit = 0;
    for (const t of nTokens) if (aTokens.has(t)) hit++;
    if (hit === nTokens.size) return { match: a, reason: "subset" };
  }
  return { match: null, reason: "no_exact_or_subset" };
}

async function s2Fetch(url) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 429) {
        const wait = 5000 * attempt;
        await sleep(wait);
        continue;
      }
      if (res.status === 404) return { ok: false, status: 404, body: null };
      if (!res.ok) {
        await sleep(3000 * attempt);
        continue;
      }
      return { ok: true, status: 200, body: await res.json() };
    } catch (e) {
      await sleep(4000 * attempt);
    }
  }
  return { ok: false, status: 0, body: null };
}

for (const lead of TARGETS) {
  let paper = null;
  let src = null;
  let reason = "";

  const byArxiv = await s2Fetch(`${S2_BASE}/paper/arxiv:${lead.arxiv_id}?fields=${FIELDS}`);
  if (byArxiv.ok) {
    paper = byArxiv.body;
    src = "arxiv_id";
  } else {
    reason = `arxiv_http_${byArxiv.status}`;
    await sleep(3000);
    const q = encodeURIComponent(lead.paper_title || "");
    const search = await s2Fetch(`${S2_BASE}/paper/search?query=${q}&limit=5&fields=${FIELDS}`);
    if (search.ok && search.body?.data?.length) {
      let best = null, bestScore = 0;
      for (const c of search.body.data) {
        const s = titleOverlap(lead.paper_title, c.title);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (best && bestScore >= 0.6) {
        paper = best;
        src = `title_search(${bestScore.toFixed(2)})`;
      } else {
        reason = `title_overlap_low(${bestScore.toFixed(2)})`;
      }
    } else {
      reason += `;title_search_http_${search.status}`;
    }
  }

  if (!paper) {
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, status: "FAIL_PAPER", reason }));
    await sleep(3000);
    continue;
  }

  const { match, reason: matchReason } = pickAuthor(lead.name, paper.authors);
  if (!match) {
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, status: "NO_MATCH", reason: matchReason, paper_title_s2: paper.title, authors: paper.authors?.map(a => a.name) }));
    await sleep(3000);
    continue;
  }

  const patch = {};
  if (match.hIndex != null) patch.h_index = match.hIndex;
  if (match.citationCount != null) patch.citation_count = match.citationCount;
  if (match.paperCount != null) patch.paper_count = match.paperCount;
  if ((lead.school == null || lead.school === "") && Array.isArray(match.affiliations) && match.affiliations.length > 0) {
    patch.school_name = match.affiliations[0];
  }

  if (Object.keys(patch).length === 0) {
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, matched: match.name, status: "skip_null", src, reason: matchReason }));
  } else {
    const { error } = await sb.from("pipeline_leads").update(patch).eq("id", lead.id);
    console.log(JSON.stringify({
      id: lead.id.slice(0, 8),
      name: lead.name,
      matched: match.name,
      h: match.hIndex ?? null,
      cites: match.citationCount ?? null,
      pc: match.paperCount ?? null,
      school_fill: patch.school_name || null,
      src,
      reason: matchReason,
      update: error ? `err:${error.message}` : `ok(${Object.keys(patch).join(",")})`,
    }));
  }
  await sleep(3000);
}
