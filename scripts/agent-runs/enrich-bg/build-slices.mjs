// Build 20 slice files for the background enrichment fan-out.
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// 1. unresolved titles (split into 8)
const titles = new Set();
let off = 0;
while (true) {
  const { data } = await sb.from("email_contact_history").select("paper_title").is("paper_arxiv_id", null).not("paper_title", "is", null).range(off, off + 999);
  if (!data || data.length === 0) break;
  for (const r of data) if (r.paper_title) titles.add(r.paper_title.trim());
  off += data.length;
  if (data.length < 1000) break;
}
const titlesArr = [...titles];
const titleChunks = 8;
const titleChunkSize = Math.ceil(titlesArr.length / titleChunks);
for (let i = 0; i < titleChunks; i++) {
  const slice = titlesArr.slice(i * titleChunkSize, (i + 1) * titleChunkSize);
  writeFileSync(`scripts/agent-runs/enrich-bg/slice-${i + 1}.json`, JSON.stringify({ agent: i + 1, strategy: "resolve-titles", items: slice }, null, 2));
}
console.log(`titles split into ${titleChunks} agents (${titleChunkSize} each)`);

// 2. github repo owners (split into 4)
const { data: ghPapers } = await sb.from("papers").select("arxiv_id, github_repo").not("github_repo", "is", null);
const ghChunks = 4;
const ghChunkSize = Math.ceil(ghPapers.length / ghChunks);
for (let i = 0; i < ghChunks; i++) {
  const slice = ghPapers.slice(i * ghChunkSize, (i + 1) * ghChunkSize);
  writeFileSync(`scripts/agent-runs/enrich-bg/slice-${titleChunks + i + 1}.json`, JSON.stringify({ agent: titleChunks + i + 1, strategy: "gh-repo", items: slice }, null, 2));
}
console.log(`github split into ${ghChunks} agents (${ghChunkSize} each)`);

// 3. PDF covers — papers without extracted hf or gh repo (might still have one we missed)
const { data: pdfPapers } = await sb.from("papers").select("arxiv_id, hf_repo, github_repo").or("hf_repo.is.null,github_repo.is.null").limit(800);
const pdfChunks = 4;
const pdfChunkSize = Math.ceil(pdfPapers.length / pdfChunks);
for (let i = 0; i < pdfChunks; i++) {
  const slice = pdfPapers.slice(i * pdfChunkSize, (i + 1) * pdfChunkSize);
  writeFileSync(`scripts/agent-runs/enrich-bg/slice-${titleChunks + ghChunks + i + 1}.json`, JSON.stringify({ agent: titleChunks + ghChunks + i + 1, strategy: "pdf-cover", items: slice }, null, 2));
}
console.log(`pdf-cover split into ${pdfChunks} agents (${pdfChunkSize} each)`);

// 4. HF papers (split into 2)
const { data: hfPapers } = await sb.from("papers").select("arxiv_id, hf_repo, github_repo").is("hf_repo", null).limit(500);
const hfChunks = 2;
const hfChunkSize = Math.ceil(hfPapers.length / hfChunks);
for (let i = 0; i < hfChunks; i++) {
  const slice = hfPapers.slice(i * hfChunkSize, (i + 1) * hfChunkSize);
  writeFileSync(`scripts/agent-runs/enrich-bg/slice-${titleChunks + ghChunks + pdfChunks + i + 1}.json`, JSON.stringify({ agent: titleChunks + ghChunks + pdfChunks + i + 1, strategy: "hf-papers", items: slice }, null, 2));
}
console.log(`hf-papers split into ${hfChunks} agents (${hfChunkSize} each)`);

// 5. Tavily citations (1 slice — tavily is slow, can't parallelize meaningfully)
const { data: needCites } = await sb.from("persons").select("id, real_name, emails").not("real_name", "is", null).is("citation_count", null).limit(500);
writeFileSync(`scripts/agent-runs/enrich-bg/slice-19.json`, JSON.stringify({ agent: 19, strategy: "tavily", items: needCites }, null, 2));
console.log(`tavily: 1 agent (${needCites.length} persons)`);

// 6. s2-paper enrichment (will run after resolve-titles unlocks it; queue now anyway)
const { data: ehPapers } = await sb.from("email_contact_history").select("email, paper_arxiv_id, person_id").not("paper_arxiv_id", "is", null).not("person_id", "is", null).limit(2000);
writeFileSync(`scripts/agent-runs/enrich-bg/slice-20.json`, JSON.stringify({ agent: 20, strategy: "s2-paper", items: ehPapers }, null, 2));
console.log(`s2-paper: 1 agent (${ehPapers.length} pairs)`);

console.log(`\nTotal: 20 slices written to scripts/agent-runs/enrich-bg/`);
