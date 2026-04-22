# Discovery scrapers — Python ↔ Supabase contract

The Python scrapers (HuggingFace / Product Hunt / GitHub) run on the
operator's laptop and write into Supabase. The Next.js dashboard reads
from `discovery_leads` and surfaces it via `/api/discovery` and
`/api/pipeline/analytics`.

## Tables

```sql
discovery_leads (
  id           bigserial primary key,
  source       text not null,           -- 'hf' | 'ph' | 'github'
  external_id  text not null,           -- hf username / ph username / gh login
  score        real not null default 0,
  signals      jsonb not null default '{}',
  profile_url  text,
  fullname     text,
  location     text,
  org          text,
  bio          text,
  contact_hint text,
  email        text,                    -- nullable; filled when discovered
  promoted_at  timestamptz,             -- set by dashboard when copied to pipeline_leads
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  hit_count    int not null default 1,
  unique (source, external_id)
);

scan_state (
  scan_type        text primary key,    -- 'hf_models' | 'ph_posts' | 'gh_trending'
  cursor_timestamp timestamptz,
  cursor_token     text,
  last_run_at      timestamptz
);
```

Apply via Supabase SQL Editor (paste `migrations/004-discovery-leads.sql`)
or `POST /api/migrate/004-discovery` which probes the tables and returns
the SQL if missing (Supabase service role can't run DDL via REST).

## REQUIRED vs OPTIONAL fields per source

`source`, `external_id`, `score`, `signals` are **required** for every
row (the helper enforces this). Everything else is best-effort — fill what
you have, leave the rest as `None`.

| Field          | Required? | hf                       | ph                       | github                  |
|----------------|-----------|--------------------------|--------------------------|-------------------------|
| `source`       | yes       | `'hf'`                   | `'ph'`                   | `'github'`              |
| `external_id`  | yes       | HF username              | PH username              | GH login                |
| `score`        | yes       | model-quality score      | upvotes-derived          | stars/repo signal       |
| `signals`      | yes (`{}` ok) | top model, dl count  | maker-of, taglines       | top repo, langs         |
| `profile_url`  | strong rec| `huggingface.co/<u>`     | `producthunt.com/@<u>`   | `github.com/<u>`        |
| `fullname`     | rec       | display name             | display name             | name                    |
| `email`        | optional  | from HF profile          | rarely available         | public profile email    |
| `org`          | optional  | from HF profile          | maker company            | from GH profile         |
| `location`     | optional  | from HF profile          | from PH profile          | from GH profile         |
| `bio`          | optional  | profile bio (first 200c) | tagline / short bio      | profile bio             |
| `contact_hint` | optional  | inferred email guess     | inferred email guess     | inferred email guess    |

`score` should be a normalized 0..1 if possible — the dashboard orders
discovery rows by `score desc`, so calibrating across sources helps the
UI surface good leads first. If you don't have a meaningful score yet,
pass `0.0` — rows still appear, just at the bottom.

## `signals` jsonb — example shapes per source

`signals` must be a JSON object (the column is `not null default '{}'`).
Use it for anything you want chips/badges for in the UI. Keys the
dashboard already understands and renders nicely:

  - `cn_org`, `cn_founder`, `cn_based`, `zh_readme`, `chinese_bio` — render as a CN tint chip
  - `verified`, `trending`, `recent_push`, `first_launch` — boolean badges
  - `model_count`, `star_count`, `followers`, `upvotes`, `contributors`, `rank` — numeric chips
  - `twitter` / `twitter_handle`, `website` / `homepage` / `blog` — surfaced as contact-hint links
  - `affiliation` — backup org chip when `lead.org` is empty

Anything else just goes into the bag and is queryable later via
Supabase's `->>` operator. Examples per source:

```jsonc
// hf
{
  "top_model": "nanoGPT",
  "downloads": 12000,
  "model_count": 14,
  "followers": 8200,
  "verified": true,
  "cn_org": true,           // optional; render hint
  "primary_arxiv": "2501.12345"
}

// ph
{
  "tagline": "AI-powered receipts",
  "upvotes": 432,
  "rank": 3,
  "maker_of": "Recyclopedia",
  "first_launch": true,
  "twitter": "lenaakim"
}

// github
{
  "top_repo": "owner/llm-eval",
  "star_count": 1240,
  "languages": ["Python", "Rust"],
  "contributors": 7,
  "recent_push": true,
  "trending": true,
  "website": "https://lena.dev"
}
```

## Upsert pattern (`supabase-py`)

Always upsert on the `(source, external_id)` natural key, and stamp
`last_seen` with an ISO-8601 string (NOT the literal string `"now()"` —
PostgREST will not evaluate SQL functions inside JSON values; it will
either store the string verbatim or reject it). Do **not** set
`first_seen` on upsert — it has `default now()` which only fires on
insert, so leaving it out preserves the original value across re-scans:

```python
from datetime import datetime, timezone

now_iso = datetime.now(timezone.utc).isoformat()

sb.table("discovery_leads").upsert(
    {
        "source": "hf",
        "external_id": "karpathy",
        "score": 0.92,
        "signals": {"top_model": "nanoGPT", "downloads": 12000},
        "profile_url": "https://huggingface.co/karpathy",
        "fullname": "Andrej Karpathy",
        "location": "USA",
        "org": "Eureka Labs",
        "bio": "...",
        "email": None,            # nullable
        "last_seen": now_iso,     # ISO string, NOT "now()"
        "hit_count": 1,           # increment client-side if you re-saw them
    },
    on_conflict="source,external_id",   # name(s) of the unique constraint columns
).execute()
```

`on_conflict` takes the **column list** of the unique constraint
(`source,external_id`) — supabase-py passes it through to PostgREST as
the `on_conflict=` query param.

If you need a true atomic increment of `hit_count`, run a small RPC or
fall back to a SELECT-then-UPDATE. For the v0 scrapers, set `hit_count`
to the number of times you saw the user **in this run**.

## Cursor pattern (`scan_state`)

One row per scan type. Use `cursor_timestamp` for time-based feeds (HF
model `lastModified`), `cursor_token` for opaque pagination tokens
(GraphQL `after` cursors). You can use both at once.

```python
from datetime import datetime, timezone

# Read cursor at the start of a run.
state = (
    sb.table("scan_state")
    .select("*")
    .eq("scan_type", "hf_models")
    .maybe_single()
    .execute()
    .data
)
since = state["cursor_timestamp"] if state else None

# ... fetch items with createdAt > since ...
# ... track the newest createdAt you saw as `new_max_ts` ...

now_iso = datetime.now(timezone.utc).isoformat()
sb.table("scan_state").upsert(
    {
        "scan_type": "hf_models",
        "cursor_timestamp": new_max_ts,                 # ISO string or None
        "cursor_token": opaque_next_page_token,         # or None
        "last_run_at": now_iso,
    },
    on_conflict="scan_type",
).execute()
```

Recommended `scan_type` values: `hf_models`, `hf_datasets`, `ph_posts`,
`gh_trending`. Pick whatever you like — it's just a primary key.

## Notes

- `promoted_at` is **dashboard-owned**. Python should never write it.
- The dashboard's `/api/discovery` endpoint returns rows ordered by
  `score desc` and excludes `promoted_at IS NOT NULL` by default
  (pass `?includePromoted=true` to inspect history).
- Empty `signals` should be `{}`, not `null` (column is `not null`).
- Use the helper at `scripts/discovery_supabase_helper.py` — it wraps
  these patterns so you can drop them into the HF / PH scripts in 3 lines.
