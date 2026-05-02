// Master enrichment script — implements all 7 strategies from
// skills/paper-enrichment/SKILL.md.
//
// Subcommands:
//   node scripts/enrich-net.mjs status              # print net coverage
//   node scripts/enrich-net.mjs all                 # run every strategy
//   node scripts/enrich-net.mjs --strategy <name>   # only one
//   node scripts/enrich-net.mjs --paper <arxiv_id>  # one paper
//   node scripts/enrich-net.mjs --person <uuid>     # one person
//
// Strategies (run in this order in `all`):
//   s2-paper      — paper.arxiv_id → S2 author block → real_name + h_index
//   pdf-cover     — paper.arxiv_id → PDF first 150KB → emails + repos
//   hf-papers     — paper.arxiv_id → huggingface.co/papers/<id> → repos
//   gh-repo       — papers.github_repo → owner profile + commit emails
//   hf-repo       — papers.hf_repo → owner profile + org membership
//   tavily        — name + email_domain → Scholar citations (fallback)
//   resolve-titles — email_contact_history.paper_title → arxiv_id (S2)

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── shared helpers ──────────────────────────────────────────────────────

const HF_PATTERN = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;
const EMAIL_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BAD_EMAIL_DOMAINS = new Set(["adobe.com", "ams.org", "arxiv.org", "ctan.org", "openreview.net", "tex.stackexchange.com", "ieee.org", "acm.org"]);

function normRepo(r) { return r.replace(/[.,)\]\s]+$/, "").trim(); }
function pickRepo(arr) {
  const f = arr.filter((r) => !r.toLowerCase().startsWith("anonymous/"));
  const c = new Map();
  for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
function isRealEmail(e) {
  const d = (e.split("@")[1] ?? "").toLowerCase();
  if (BAD_EMAIL_DOMAINS.has(d)) return false;
  if ((e.split("@")[0] ?? "").length < 2) return false;
  return true;
}

// ─── Strategy 1: S2 paper → author block → enrich person ─────────────────

async function strategyS2Paper(opts = {}) {
  console.log("\n═══ Strategy: s2-paper ═══");
  // Get every (person, paper_arxiv_id) pair where person lacks real_name
  const { data: hist } = await sb
    .from("email_contact_history")
    .select("email, paper_arxiv_id, person_id")
    .not("paper_arxiv_id", "is", null)
    .not("person_id", "is", null);

  const personToPaper = new Map();
  for (const h of hist) {
    if (!personToPaper.has(h.person_id)) {
      personToPaper.set(h.person_id, { email: h.email.toLowerCase(), arxiv_id: h.paper_arxiv_id });
    }
  }

  // Page through to filter to persons without real_name
  const personIds = [...personToPaper.keys()];
  const enrichable = [];
  for (let i = 0; i < personIds.length; i += 1000) {
    const slice = personIds.slice(i, i + 1000);
    const { data } = await sb.from("persons").select("id, real_name, emails, affiliation, s2_author_id").in("id", slice).is("real_name", null);
    if (data) enrichable.push(...data);
  }
  console.log(`  enrichable: ${enrichable.length} persons with paper context but no real_name`);

  const limit = opts.limit ?? enrichable.length;
  let i = 0, enriched = 0, fail = 0, papersCached = new Map();
  for (const person of enrichable.slice(0, limit)) {
    i++;
    const ctx = personToPaper.get(person.id);
    if (!ctx) continue;
    let paperData = papersCached.get(ctx.arxiv_id);
    if (!paperData) {
      try {
        const url = `${S2_BASE}/paper/arxiv:${ctx.arxiv_id}?fields=title,authors.name,authors.authorId,authors.affiliations,authors.hIndex,authors.citationCount`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          paperData = await res.json();
          papersCached.set(ctx.arxiv_id, paperData);
        } else {
          fail++;
          await sleep(1100);
          continue;
        }
      } catch {
        fail++;
        await sleep(1100);
        continue;
      }
    }
    const authors = paperData.authors ?? [];
    const prefix = ctx.email.split("@")[0].toLowerCase().replace(/[._-]/g, "");
    let match = null;
    for (const a of authors) {
      const an = (a.name || "").toLowerCase().replace(/[\s.]/g, "");
      if (an.includes(prefix) || prefix.includes(an)) { match = a; break; }
    }
    if (!match) match = authors[0];
    if (!match) { fail++; continue; }

    const update = {
      real_name: match.name,
      affiliation: (match.affiliations ?? [])[0] ?? null,
      s2_author_id: match.authorId ?? null,
    };
    const { error } = await sb.from("persons").update(update).eq("id", person.id);
    if (!error) enriched++;
    else fail++;
    if (i % 20 === 0) process.stdout.write(`  ${i}/${limit} (enriched=${enriched})\r`);
    await sleep(1100);
  }
  process.stdout.write("\n");
  console.log(`  s2-paper: enriched ${enriched}, failed ${fail}`);
  return { enriched, fail };
}

// ─── Strategy 2: PDF cover-page extraction ───────────────────────────────

async function strategyPdfCover(opts = {}) {
  console.log("\n═══ Strategy: pdf-cover ═══");
  const { data: papers } = await sb
    .from("papers")
    .select("arxiv_id, hf_repo, github_repo")
    .not("arxiv_id", "is", null);
  console.log(`  ${papers.length} papers to scan`);
  const limit = opts.limit ?? papers.length;
  let done = 0, withEmails = 0, repoUpdates = 0, totalEmails = 0;
  const queue = papers.slice(0, limit);
  const CONC = 8;
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (!p) break;
      done++;
      const id = p.arxiv_id.replace(/v\d+$/, "");
      try {
        const res = await fetch(`https://arxiv.org/pdf/${id}`, {
          signal: AbortSignal.timeout(20_000),
          headers: { Range: "bytes=0-153600" },
        });
        if (!res.ok && res.status !== 206) continue;
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let text = "";
        for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          text += (c >= 32 && c < 127) || c === 10 || c === 13 ? String.fromCharCode(c) : " ";
        }
        text = text.replace(/\s+/g, " ");
        const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].filter(isRealEmail).slice(0, 20);
        const hf = pickRepo([...text.matchAll(HF_PATTERN)].map((m) => normRepo(m[1])));
        const gh = pickRepo([...text.matchAll(GH_PATTERN)].map((m) => normRepo(m[1])));

        const update = {};
        if (hf && !p.hf_repo) update.hf_repo = hf;
        if (gh && !p.github_repo) update.github_repo = gh;
        if (Object.keys(update).length > 0) {
          await sb.from("papers").update(update).eq("arxiv_id", p.arxiv_id);
          repoUpdates++;
        }
        if (emails.length > 0) {
          withEmails++;
          totalEmails += emails.length;
          // Merge to persons: any email already on a person? If yes, no-op
          // (we don't merge co-authors). If no, create a new persons row.
          for (const email of emails) {
            const { data: dup } = await sb.from("persons").select("id").contains("emails", [email]).maybeSingle();
            if (dup) continue;
            await sb.from("persons").insert({
              emails: [email],
              outreach_status: "new",
              source_events: [{ kind: "paper_pdf", arxiv_id: id, found_at: new Date().toISOString() }],
            });
          }
        }
      } catch { /* skip */ }
      if (done % 25 === 0) process.stdout.write(`  ${done}/${limit} (emails=${withEmails}, repos+=${repoUpdates})\r`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write("\n");
  console.log(`  pdf-cover: scanned ${done}, ${withEmails} papers had emails (total ${totalEmails}), ${repoUpdates} repo updates`);
  return { withEmails, totalEmails, repoUpdates };
}

// ─── Strategy 3: HF papers page ──────────────────────────────────────────

async function strategyHfPapers(opts = {}) {
  console.log("\n═══ Strategy: hf-papers ═══");
  const { data: papers } = await sb.from("papers").select("arxiv_id, hf_repo, github_repo");
  const limit = opts.limit ?? papers.length;
  let i = 0, indexed = 0, hfFound = 0, ghFound = 0;
  const queue = papers.slice(0, limit);
  const CONC = 6;
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (!p) break;
      i++;
      const id = p.arxiv_id.replace(/v\d+$/, "");
      try {
        const res = await fetch(`https://huggingface.co/papers/${id}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        indexed++;
        const html = await res.text();
        const update = {};
        if (!p.hf_repo) {
          const m = pickRepo([...html.matchAll(/\/(models|datasets|spaces)\/([\w-]+\/[\w.-]+)/g)].map((m) => normRepo(m[2])));
          if (m) { update.hf_repo = m; hfFound++; }
        }
        if (!p.github_repo) {
          const m = pickRepo([...html.matchAll(GH_PATTERN)].map((m) => normRepo(m[1])));
          if (m) { update.github_repo = m; ghFound++; }
        }
        if (Object.keys(update).length > 0) {
          await sb.from("papers").update(update).eq("arxiv_id", p.arxiv_id);
        }
      } catch { /* skip */ }
      if (i % 25 === 0) process.stdout.write(`  ${i}/${limit} (indexed=${indexed}, hf+=${hfFound}, gh+=${ghFound})\r`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write("\n");
  console.log(`  hf-papers: ${i} scanned, ${indexed} found, hf+=${hfFound}, gh+=${ghFound}`);
  return { indexed, hfFound, ghFound };
}

// ─── Strategy 4: GitHub repo → owner profile + commit emails ─────────────

async function strategyGhRepo(opts = {}) {
  console.log("\n═══ Strategy: gh-repo ═══");
  const { data: papers } = await sb.from("papers").select("arxiv_id, github_repo").not("github_repo", "is", null);
  console.log(`  ${papers.length} papers with github_repo`);
  const limit = opts.limit ?? papers.length;
  let i = 0, ownerEnriched = 0, newEmails = 0, ghLinked = 0;
  const queue = papers.slice(0, limit);
  const CONC = 4;
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (!p) break;
      i++;
      const [owner, repo] = (p.github_repo ?? "").split("/");
      if (!owner || !repo) continue;
      try {
        const profRes = await fetch(`https://api.github.com/users/${owner}`, { signal: AbortSignal.timeout(10_000) });
        if (!profRes.ok) continue;
        const prof = await profRes.json();
        const profEmail = prof.email?.toLowerCase();
        const profName = prof.name;
        // If owner has a public email, attach to a person OR create new
        if (profEmail && isRealEmail(profEmail)) {
          const { data: existing } = await sb.from("persons").select("id, github_users, real_name").contains("emails", [profEmail]).maybeSingle();
          if (existing) {
            const ghs = new Set(existing.github_users ?? []);
            if (!ghs.has(owner)) {
              ghs.add(owner);
              await sb.from("persons").update({
                github_users: [...ghs],
                real_name: existing.real_name ?? profName ?? null,
              }).eq("id", existing.id);
              ghLinked++;
            }
          } else {
            await sb.from("persons").insert({
              emails: [profEmail],
              github_users: [owner],
              real_name: profName,
              outreach_status: "new",
              source_events: [{ kind: "github_owner", repo: p.github_repo, found_at: new Date().toISOString() }],
            });
            newEmails++;
          }
          ownerEnriched++;
        }
        // Pull commit emails too
        const commitsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=10`, { signal: AbortSignal.timeout(10_000) });
        if (commitsRes.ok) {
          const commits = await commitsRes.json();
          const commitEmails = new Set();
          for (const c of (Array.isArray(commits) ? commits : [])) {
            const e = c.commit?.author?.email?.toLowerCase();
            if (e && isRealEmail(e) && !e.includes("noreply.github.com")) commitEmails.add(e);
          }
          for (const ce of commitEmails) {
            const { data: dup } = await sb.from("persons").select("id").contains("emails", [ce]).maybeSingle();
            if (!dup) {
              await sb.from("persons").insert({
                emails: [ce],
                source_events: [{ kind: "github_commit", repo: p.github_repo, found_at: new Date().toISOString() }],
              });
              newEmails++;
            }
          }
        }
      } catch { /* skip */ }
      if (i % 10 === 0) process.stdout.write(`  ${i}/${limit} (owner+=${ownerEnriched}, gh-link+=${ghLinked}, new=${newEmails})\r`);
      await sleep(500); // GH API: 60/hr unauth, 5000/hr auth — be polite
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write("\n");
  console.log(`  gh-repo: ${i} scanned, ${ownerEnriched} owners enriched, ${ghLinked} gh-users linked, ${newEmails} new emails`);
  return { ownerEnriched, ghLinked, newEmails };
}

// ─── Strategy 5: HF repo → owner profile ─────────────────────────────────

async function strategyHfRepo(opts = {}) {
  console.log("\n═══ Strategy: hf-repo ═══");
  const { data: papers } = await sb.from("papers").select("arxiv_id, hf_repo").not("hf_repo", "is", null);
  console.log(`  ${papers.length} papers with hf_repo`);
  const limit = opts.limit ?? papers.length;
  let i = 0, hfLinked = 0, fail = 0;
  const queue = papers.slice(0, limit);
  for (const p of queue) {
    i++;
    const [owner] = (p.hf_repo ?? "").split("/");
    if (!owner) continue;
    try {
      const res = await fetch(`https://huggingface.co/api/users/${owner}/overview`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) { fail++; continue; }
      const prof = await res.json();
      // No email exposed by HF API — but we can attach the hf_user to any
      // person whose real_name matches
      if (prof.fullname) {
        const { data: matches } = await sb
          .from("persons")
          .select("id, hf_users")
          .eq("real_name", prof.fullname)
          .limit(1);
        if (matches && matches.length > 0) {
          const hfs = new Set(matches[0].hf_users ?? []);
          if (!hfs.has(owner)) {
            hfs.add(owner);
            await sb.from("persons").update({ hf_users: [...hfs] }).eq("id", matches[0].id);
            hfLinked++;
          }
        }
      }
    } catch { fail++; }
    if (i % 10 === 0) process.stdout.write(`  ${i}/${limit} (linked=${hfLinked})\r`);
    await sleep(300);
  }
  process.stdout.write("\n");
  console.log(`  hf-repo: ${i} scanned, ${hfLinked} hf-users linked, ${fail} fail`);
  return { hfLinked };
}

// ─── Strategy 6: Tavily fallback for citations ───────────────────────────

async function strategyTavily(opts = {}) {
  console.log("\n═══ Strategy: tavily ═══");
  if (!process.env.TAVILY_API_KEY) {
    console.log("  TAVILY_API_KEY not set — skipping");
    return { enriched: 0 };
  }
  // Persons with real_name but no citation_count
  const { data: candidates } = await sb
    .from("persons")
    .select("id, real_name, emails, citation_count")
    .not("real_name", "is", null)
    .is("citation_count", null);
  console.log(`  ${candidates.length} candidates (have name, missing citations)`);
  const limit = opts.limit ?? candidates.length;
  let i = 0, enriched = 0;
  for (const p of candidates.slice(0, limit)) {
    i++;
    const aff = (p.emails?.[0] ?? "").split("@").pop() ?? "";
    const query = `"${p.real_name}" ${aff} google scholar citations`;
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          search_depth: "basic",
          max_results: 5,
          include_domains: ["scholar.google.com", "scholar.google.co.uk"],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const snippets = (j.results ?? []).map((r) => `${r.title ?? ""}\n${r.content ?? ""}`).join("\n");
      const m = [...snippets.matchAll(/cited by\s+([\d,]+)/gi)];
      const citations = m.map((x) => parseInt(x[1].replace(/,/g, ""), 10)).filter((x) => !isNaN(x));
      if (citations.length > 0) {
        const max = Math.max(...citations);
        await sb.from("persons").update({ citation_count: max }).eq("id", p.id);
        enriched++;
      }
    } catch { /* skip */ }
    if (i % 20 === 0) process.stdout.write(`  ${i}/${limit} (enriched=${enriched})\r`);
    await sleep(500);
  }
  process.stdout.write("\n");
  console.log(`  tavily: ${i} queried, ${enriched} citation_counts added`);
  return { enriched };
}

// ─── Strategy 7: resolve titles → arxiv_id ───────────────────────────────

async function strategyResolveTitles(opts = {}) {
  console.log("\n═══ Strategy: resolve-titles (S2) ═══");
  const titles = new Set();
  let off = 0;
  while (true) {
    const { data, error } = await sb
      .from("email_contact_history")
      .select("paper_title")
      .is("paper_arxiv_id", null)
      .not("paper_title", "is", null)
      .range(off, off + 999);
    if (error || !data || data.length === 0) break;
    for (const r of data) if (r.paper_title) titles.add(r.paper_title.trim());
    off += data.length;
    if (data.length < 1000) break;
  }
  console.log(`  ${titles.size} unresolved titles`);
  const arr = [...titles];
  const limit = opts.limit ?? arr.length;
  let i = 0, wins = 0;
  const queue = arr.slice(0, limit);
  const CONC = 5;
  async function worker() {
    while (queue.length) {
      const title = queue.shift();
      if (!title) break;
      i++;
      try {
        const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 500))}&fields=title,externalIds`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const j = await res.json();
          const first = j.data?.[0];
          const arxiv = first?.externalIds?.ArXiv;
          if (arxiv) {
            wins++;
            await sb.from("papers").upsert({ arxiv_id: arxiv, title: first.title }, { onConflict: "arxiv_id" });
            await sb.from("email_contact_history")
              .update({ paper_arxiv_id: arxiv })
              .ilike("paper_title", title)
              .is("paper_arxiv_id", null);
          }
        }
      } catch { /* skip */ }
      if (i % 50 === 0) process.stdout.write(`  ${i}/${limit} (wins=${wins})\r`);
      await sleep(200);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write("\n");
  console.log(`  resolve-titles: ${i} queried, ${wins} resolved`);
  return { wins };
}

// ─── Status report ───────────────────────────────────────────────────────

async function status() {
  const c = async (table, fn = (q) => q) => (await fn(sb.from(table).select("*", { count: "exact", head: true }))).count ?? 0;
  const persTotal = await c("persons");
  const persName = await c("persons", (q) => q.not("real_name", "is", null));
  const persS2 = await c("persons", (q) => q.not("s2_author_id", "is", null));
  const persHf = await c("persons", (q) => q.not("hf_users", "eq", "{}"));
  const persGh = await c("persons", (q) => q.not("github_users", "eq", "{}"));
  const persDnc = await c("persons", (q) => q.eq("outreach_status", "do_not_contact"));
  const papersTotal = await c("papers");
  const papersHf = await c("papers", (q) => q.not("hf_repo", "is", null));
  const papersGh = await c("papers", (q) => q.not("github_repo", "is", null));
  const ehTotal = await c("email_contact_history");
  const ehArxiv = await c("email_contact_history", (q) => q.not("paper_arxiv_id", "is", null));
  console.log(`\n=== NET STATUS ===`);
  console.log(`persons: ${persTotal} (name=${persName}, s2=${persS2}, hf=${persHf}, gh=${persGh}, DNC=${persDnc})`);
  console.log(`papers:  ${papersTotal} (hf_repo=${papersHf}, github_repo=${papersGh})`);
  console.log(`history: ${ehTotal} (arxiv_linked=${ehArxiv})`);
}

// ─── Dispatch ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const strategyArg = args.indexOf("--strategy") >= 0 ? args[args.indexOf("--strategy") + 1] : null;
const limitArg = args.indexOf("--limit") >= 0 ? parseInt(args[args.indexOf("--limit") + 1], 10) : undefined;
const cmd = args[0];

if (cmd === "status") {
  await status();
  process.exit(0);
}

const all = cmd === "all";
const ran = [];

await status();

if (all || strategyArg === "resolve-titles") {
  ran.push(["resolve-titles", await strategyResolveTitles({ limit: limitArg })]);
}
if (all || strategyArg === "s2-paper") {
  ran.push(["s2-paper", await strategyS2Paper({ limit: limitArg })]);
}
if (all || strategyArg === "pdf-cover") {
  ran.push(["pdf-cover", await strategyPdfCover({ limit: limitArg })]);
}
if (all || strategyArg === "hf-papers") {
  ran.push(["hf-papers", await strategyHfPapers({ limit: limitArg })]);
}
if (all || strategyArg === "gh-repo") {
  ran.push(["gh-repo", await strategyGhRepo({ limit: limitArg })]);
}
if (all || strategyArg === "hf-repo") {
  ran.push(["hf-repo", await strategyHfRepo({ limit: limitArg })]);
}
if (all || strategyArg === "tavily") {
  ran.push(["tavily", await strategyTavily({ limit: limitArg })]);
}

console.log(`\n=== STRATEGIES RAN ===`);
for (const [name, result] of ran) console.log(`  ${name}:`, result);

await status();
