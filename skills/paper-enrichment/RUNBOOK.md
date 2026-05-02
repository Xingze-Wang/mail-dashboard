# Paper-enrichment runbook

Keep this short — the SKILL.md describes the strategy; this file describes how to run it on the live system.

## TL;DR

```bash
# Status snapshot — print before/after to see lift
node scripts/enrich-net.mjs status

# Full pipeline (all 7 strategies, ~3-4 hours total)
node scripts/enrich-net.mjs all

# One strategy at a time (use --limit N to cap)
node scripts/enrich-net.mjs --strategy resolve-titles  # title → arxiv_id (S2)
node scripts/enrich-net.mjs --strategy s2-paper        # arxiv → real_name + h-index
node scripts/enrich-net.mjs --strategy pdf-cover       # PDF → emails + repos
node scripts/enrich-net.mjs --strategy hf-papers       # HF papers page → repos
node scripts/enrich-net.mjs --strategy gh-repo         # GitHub owner profile + commits
node scripts/enrich-net.mjs --strategy hf-repo         # HF owner profile
node scripts/enrich-net.mjs --strategy tavily          # Scholar citations fallback
```

## Strategy order matters

```
resolve-titles  ─┬─►  s2-paper     (needs paper_arxiv_id on history rows)
                 │
                 ├─►  pdf-cover    (needs paper_arxiv_id on papers rows)
                 │
                 └─►  hf-papers    (needs paper_arxiv_id)
                                       │
                       ┌───────────────┤
                       │               │
                       ▼               ▼
                  gh-repo          hf-repo     (need papers.github_repo / hf_repo)
                       │               │
                       └───────┬───────┘
                               ▼
                            tavily             (needs persons.real_name to be useful)
```

Run in this order: resolve-titles → s2-paper + pdf-cover + hf-papers → gh-repo + hf-repo → tavily.

## Rate-limit notes

| API | Limit | Strategy |
|---|---|---|
| arxiv `?search_query=` | ~1 req per 3 sec | resolve-titles (slow path), pdf-cover (uses /pdf/) |
| Semantic Scholar | ~1 req/sec free, 100/sec with key | s2-paper, resolve-titles (fast path) |
| huggingface.co | unlimited for unauth GET | hf-papers, hf-repo |
| api.github.com | 60/hr unauth, 5000/hr auth | gh-repo |
| Tavily | per plan | tavily |

For GitHub at scale: set `GITHUB_TOKEN` env var before running gh-repo.
For Tavily: set `TAVILY_API_KEY`.

## Idempotency

Every strategy filters on "missing field is null" — re-running doesn't double-write. Safe to interrupt and resume.

## What gets written

| Strategy | Writes to |
|---|---|
| resolve-titles | `papers` (new rows), `email_contact_history.paper_arxiv_id` |
| s2-paper | `persons.real_name, affiliation, s2_author_id` |
| pdf-cover | `papers.hf_repo, github_repo`; new `persons` rows for extracted emails |
| hf-papers | `papers.hf_repo, github_repo` |
| gh-repo | `persons.github_users`; new `persons` rows from owner + commit emails |
| hf-repo | `persons.hf_users` |
| tavily | `persons.citation_count` |

## Co-author safety

PDFs surface 5+ emails per paper. The corresponding-author email is the input person; the rest are co-authors (different people).

The script never merges co-authors as aliases of the input person. Each new email gets its own `persons` row with `source_events: [{kind:"paper_pdf", arxiv_id}]`. They're independent identities for the dedup graph.

## Where to look

- `scripts/enrich-net.mjs` — implementation
- `skills/paper-enrichment/SKILL.md` — strategy reasoning
- `src/lib/contact-guard.ts` — the dedup gate that consumes the enriched data
- `src/lib/person-resolver.ts` — find-or-create + merge for live ingestion
- `src/lib/paper-pdf-extractor.ts` — the PDF extractor library
- `src/lib/repo-extractor.ts` — abstract → repo regex
