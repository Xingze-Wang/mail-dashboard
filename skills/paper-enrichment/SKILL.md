---
name: paper-enrichment
description: Enrich a person from their paper context. Anchors identity to a specific paper (by arxiv_id or title), then chains S2 → PDF → HF → GitHub → Tavily to recover real name, affiliation, all email aliases, and the project's HF/GitHub repos. Replaces the email-prefix-first strategy with paper-first, which avoids homonym collisions.
---

# Paper-anchored person enrichment

## Why paper-first beats email-first

The previous SKILL.md (`person-enrichment`) was email-first: take a Chinese name, find a public profile, char-match the surname. It hit the homonym wall — "Shuo Yang" matches dozens of distinct people. Two-signal verification confirms *a* Shuo Yang, not *the* Shuo Yang we want.

The fix: when the input includes a **paper** (which it does for almost every lead in our pipeline — every send was triggered by a specific arxiv paper), the paper is unique. The author of arxiv:2604.13596 is exactly one person. From that anchor we get:

- Real name (S2 paper author block — full chars when in Chinese)
- All affiliations across the author's career
- All paper IDs they've authored → corresponding-author emails on each → email aliases
- The project's official HF + GitHub repo links from the paper PDF
- The author's GitHub user (often linked from the paper repo)
- The author's HF user (often the paper repo owner)

Single anchor, six identity facets. No homonym arithmetic.

## The chain

For each `(email, paper_arxiv_id)` (or `(email, paper_title)` resolved to arxiv_id):

### Step 1: Anchor the paper
Resolve title → arxiv_id via S2 `/paper/search/match` (fast, ~30 sec for 3000 titles) or arxiv `?search_query=ti:` (slow, polite ~1 req/3 sec, but more robust for in-progress papers).

### Step 2: Pull the S2 paper's author block
```
https://api.semanticscholar.org/graph/v1/paper/arxiv:2604.13596?fields=title,authors.name,authors.authorId,authors.affiliations,authors.hIndex,authors.citationCount
```
Match the email's local part to one of the author names by token overlap (`renqihan` → matches "Qihan Ren"). When in doubt, take the author whose affiliation matches the email domain (`@buaa.edu.cn` → BUAA).

Write to persons row: `real_name`, `affiliation`, `s2_author_id`, `h_index`, `citation_count`.

### Step 3: Fetch paper PDF cover page
```
https://arxiv.org/pdf/<arxiv_id>
Range: bytes=0-153600
```
Extract:
- All emails matching `[\w.+-]+@[\w.-]+` (filter boilerplate domains: arxiv.org, ieee.org, acm.org, ams.org)
- All `github.com/owner/repo` URLs
- All `huggingface.co/...` URLs

The corresponding-author email is the gold disambiguator. If it matches `email`, identity is confirmed end-to-end. If it surfaces NEW emails, those are aliases (or co-author emails — be careful: co-authors are different people, do NOT merge).

### Step 4: Try huggingface.co/papers/<arxiv_id>
When indexed, HF surfaces the official model/dataset/space repos for the paper. These are higher-confidence than abstract regex because HF requires the paper author to claim the model.

### Step 5: From the GitHub repo, lift the author identity
```
https://api.github.com/repos/<owner>/<repo>
https://api.github.com/repos/<owner>/<repo>/commits?per_page=10
https://api.github.com/users/<owner>
```
- Repo owner profile: name, company, blog, email (sometimes)
- Recent commits: author email, message
- README: often has "Cite our paper" section + corresponding email

### Step 6: From the HF repo, lift the author
```
https://huggingface.co/api/models/<owner>/<repo>
https://huggingface.co/api/users/<owner>/overview
```
- Owner's full name, organizations they're a member of
- HF org membership is gatekept — `KingsCollegeLondon` membership = institutional researcher

### Step 7: Tavily fallback for missing citations
If S2 returned no profile (rare but happens for new PhDs / industry):
```
Tavily search: "<author_name>" <email_domain> google scholar citations
```
Pull citation count from snippet text.

## What to write back

For each enriched person row:

| Column | Source |
|---|---|
| `real_name` | S2 paper author block |
| `affiliation` | S2 author affiliations (most recent) |
| `s2_author_id` | S2 |
| `h_index` | S2 |
| `citation_count` | S2 (or Tavily fallback) |
| `emails` (append, dedupe) | PDF cover page + repo commits + S2 author profile (via paper) |
| `hf_users` (append) | HF repo owner |
| `github_users` (append) | GitHub repo owner |
| `arxiv_author_names` (append) | S2 author name (preserve as-published) |
| `source_events` (append) | `{kind:"paper_pdf", arxiv_id, found_at}` per call |

For each enriched paper row in `papers`:

| Column | Source |
|---|---|
| `hf_repo` | PDF / HF papers page |
| `github_repo` | PDF / HF papers page |
| `last_outreach_at` | scanner.recordContact |
| `outreach_count` | scanner.recordContact |

## Robustness rules

1. **Never merge co-authors as aliases.** PDF gives N emails per paper; one is the corresponding author (the input email match), the rest are co-authors. Each co-author gets their own persons row, not appended to the input person.

2. **Always confirm via 2 signals before writing real_name.** S2 author + email-domain match (e.g. `liusi@buaa.edu.cn` + S2 affiliation "Beihang University") = verified.

3. **DNC takes priority over identity confirmation.** If you find a verified email for a DNC person, write it to their `emails[]` immediately — that strengthens the dedup gate.

4. **Stale identity isn't identity.** S2 affiliations can be 5+ years old. For *current* affiliation, prefer paper PDF first-page footnote ("Author A is now at Org Y") over S2.

5. **Co-author emails are leads, not aliases.** When a paper PDF surfaces 5 emails and only 1 matches our person, the other 4 are new people we haven't contacted — useful for the lead pipeline, not for identity merge.

## Running it

The full chain is implemented in `scripts/enrich-net.mjs`. It's idempotent. Subcommands:

```bash
node scripts/enrich-net.mjs all              # all 7 strategies on every persons row
node scripts/enrich-net.mjs --paper 2604.13596   # one paper
node scripts/enrich-net.mjs --person <uuid>      # one person
node scripts/enrich-net.mjs --strategy s2        # only S2 step
node scripts/enrich-net.mjs --strategy pdf       # only PDF step
node scripts/enrich-net.mjs --strategy hf-page   # only HF papers page
node scripts/enrich-net.mjs --strategy gh-repo   # only GitHub repo crawl
node scripts/enrich-net.mjs --strategy hf-repo   # only HF repo crawl
node scripts/enrich-net.mjs --strategy tavily    # only Tavily fallback
```

Each strategy reports its own coverage delta (e.g. "S2 added real_name to 47 persons"), so you can ship one strategy at a time and watch the lift.
