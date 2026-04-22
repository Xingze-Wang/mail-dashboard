"""
discovery_supabase_helper.py — drop-in upsert + cursor helpers for the
Python discovery scrapers (HF / Product Hunt / GitHub).

Wires the patterns documented in `docs/discovery-python-contract.md`.

Setup
    pip install supabase python-dotenv
    export SUPABASE_URL=https://xxx.supabase.co
    export SUPABASE_SERVICE_KEY=eyJ...

Drop into your scraper:
    from discovery_supabase_helper import (
        upsert_discovery_lead, get_cursor, set_cursor,
    )
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

from supabase import create_client, Client

# Match the precedent set by migrations/migrate_to_persons.py — accept
# either SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL.
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required. "
        "Get them from supabase.com → project → Settings → API."
    )

sb: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def upsert_discovery_lead(
    source: str,
    external_id: str,
    score: float,
    signals: dict[str, Any],
    *,
    profile_url: Optional[str] = None,
    fullname: Optional[str] = None,
    location: Optional[str] = None,
    org: Optional[str] = None,
    bio: Optional[str] = None,
    contact_hint: Optional[str] = None,
    email: Optional[str] = None,
    hit_count: int = 1,
) -> dict[str, Any]:
    """Upsert one row into discovery_leads on (source, external_id).

    Required: source, external_id, score, signals (use {} for none).
    Everything else is optional — pass what you have, leave the rest None.
    `first_seen` is intentionally not written here so Postgres' default
    only fires on first insert and survives re-scans.
    """
    if signals is None:
        signals = {}
    payload: dict[str, Any] = {
        "source": source,
        "external_id": external_id,
        "score": float(score),
        "signals": signals,
        "profile_url": profile_url,
        "fullname": fullname,
        "location": location,
        "org": org,
        "bio": bio,
        "contact_hint": contact_hint,
        "email": email,
        "last_seen": _now_iso(),
        "hit_count": hit_count,
    }
    res = sb.table("discovery_leads").upsert(
        payload, on_conflict="source,external_id"
    ).execute()
    return (res.data or [{}])[0]


def get_cursor(scan_type: str) -> Optional[dict[str, Any]]:
    """Read the cursor row for `scan_type`. Returns None on first run."""
    res = (
        sb.table("scan_state")
        .select("*")
        .eq("scan_type", scan_type)
        .maybe_single()
        .execute()
    )
    return res.data if res and res.data else None


def set_cursor(
    scan_type: str,
    cursor_timestamp: Optional[str] = None,
    cursor_token: Optional[str] = None,
) -> None:
    """Write the cursor for `scan_type`. Pass either ts (ISO string), token, or both."""
    sb.table("scan_state").upsert(
        {
            "scan_type": scan_type,
            "cursor_timestamp": cursor_timestamp,
            "cursor_token": cursor_token,
            "last_run_at": _now_iso(),
        },
        on_conflict="scan_type",
    ).execute()


# ─── Example: integrate into the existing hf1.py scout ───────────────────
# After you've enriched a candidate (you have `c["user"]`, `c["fullname"]`,
# `c["bio"]`, `c["num_followers"]`, optionally `c.get("email")`):
#
#   from discovery_supabase_helper import upsert_discovery_lead, set_cursor
#   upsert_discovery_lead(
#       source="hf",
#       external_id=c["user"],
#       score=min(1.0, c.get("num_followers", 0) / 1000.0),
#       signals={"followers": c.get("num_followers", 0),
#                "primary_arxiv": c.get("primary_arxiv"),
#                "repo": c["repo"]},
#       profile_url=f"https://huggingface.co/{c['user']}",
#       fullname=c.get("fullname"),
#       bio=c.get("bio"),
#       email=c.get("email"),
#   )
#   # at end of run, after writing checkpoint files:
#   set_cursor("hf_models", cursor_token=new_ckpts.get("models"))
