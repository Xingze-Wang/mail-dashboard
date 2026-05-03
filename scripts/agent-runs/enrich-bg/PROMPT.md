# Background enrichment agent

You are one of 20 parallel agents enriching the dedup net. Your task is one of these strategies (passed in your dispatch):

- `resolve-titles`: take a slice of unresolved paper titles → arxiv_id (via S2 + arxiv search + Tavily fallback)
- `s2-paper`: take a slice of (person, paper_arxiv_id) → real_name + h_index + affiliation
- `pdf-cover`: take a slice of papers → PDF first 150KB → emails + repos
- `hf-papers`: take a slice of papers → hugging face papers page → repos
- `gh-repo`: take a slice of papers with github_repo → owner profile + commit emails → new persons
- `hf-repo`: take a slice of papers with hf_repo → owner profile → link hf_user

## You will receive
- A slice file at `scripts/agent-runs/enrich-bg/slice-{N}.json` containing `{ strategy, items: [...] }`
- DB credentials baked into `scripts/enrich-net.mjs`

## Run

Run the corresponding strategy from `scripts/enrich-net.mjs`. The script is idempotent — only writes to nullable fields. Concurrency is 4-8 internally already; use it.

## Coordination

If your slice produces co-author emails, attach them as **new persons rows** (not as aliases). The dedup graph treats co-authors as independent identities.

If you find Chinese-character names, write them as `real_name` directly. Don't try to verify char-match in this background pass — the paper anchor already gives you the right person.

## Output

Append a one-line JSONL summary to `scripts/agent-runs/enrich-bg/summary.jsonl`:
```json
{"agent":"<N>","strategy":"<name>","scanned":N,"wins":N,"errors":N,"new_persons":N,"duration_ms":N}
```

Do NOT modify other agents' slice files. Do NOT delete persons rows.
