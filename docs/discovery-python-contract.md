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

## Required fields per source

| Field         | hf                  | ph                  | github              |
|---------------|---------------------|---------------------|---------------------|
| `source`      | `'hf'`              | `'ph'`              | `'github'`          |
| `external_id` | HF username         | PH username         | GH login            |
| `profile_url` | `huggingface.co/<u>`| `producthunt.com/@<u>` | `github.com/<u>` |
| `score`       | model-quality score | upvotes-derived     | stars/repo signal   |
| `signals`     | top model, dl count | maker-of, taglines  | top repo, langs     |
| `fullname`    | display name        | display name        | name                |
| `email`       | from HF profile     | rarely available    | public profile email|

`org`, `location`, `bio`, `contact_hint` are best-effort.

## Upsert pattern (`supabase-py`)

Always upsert on the `(source, external_id)` natural key, and always
stamp `last_seen` and bump `hit_count`. Do **not** set `first_seen` on
upsert — Postgres preserves the existing value because of `default now()`
on insert only:

```python
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
        "email": None,
        "last_seen": "now()",            # postgres timestamp
        "hit_count": 1,                  # increment client-side if you re-saw them
    },
    on_conflict="source,external_id",
).execute()
```

If you need a true atomic increment of `hit_count`, run a small RPC or
fall back to a SELECT-then-UPDATE. For the v0 scrapers, set `hit_count`
to the number of times you saw the user **in this run**.

## Cursor pattern

```python
state = sb.table("scan_state").select("*").eq("scan_type", "hf_models").maybe_single().execute().data
since = state["cursor_timestamp"] if state else None
# ... fetch since `since` ...
sb.table("scan_state").upsert(
    {
        "scan_type": "hf_models",
        "cursor_timestamp": new_max_ts,
        "cursor_token": opaque_next_page_token,  # or None
        "last_run_at": "now()",
    },
    on_conflict="scan_type",
).execute()
```

Use `cursor_timestamp` for time-based feeds (HF model `lastModified`),
`cursor_token` for opaque pagination tokens (GraphQL `after` cursors).

## Notes

- `promoted_at` is **dashboard-owned**. Python should never write it.
- The dashboard's `/api/discovery` endpoint returns rows ordered by
  `score desc`. Set a meaningful score per source — even a normalized
  0..1 — so the UI surfaces good leads first.
- Empty `signals` should be `{}`, not `null` (column is `not null`).
