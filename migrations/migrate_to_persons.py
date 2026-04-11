#!/usr/bin/env python3
"""
migrate_to_persons.py — 一次性迁移: 建 persons 表的历史数据

做三件事:
  1. 读 email_contact_history 表 → 每条历史建一个 person
  2. 读 paper_authors 表 (有邮箱的) → 合并进 person
  3. 读本地 email_history.json → 补齐可能还没入库的

所有操作幂等,可安全重跑。

用法:
    pip install supabase python-dotenv
    python migrate_to_persons.py --dry-run        # 先看有多少条要处理
    python migrate_to_persons.py --commit         # 真正写入

环境变量:
    SUPABASE_URL=https://xxx.supabase.co
    SUPABASE_SERVICE_KEY=eyJ...
"""
import os, json, argparse
from pathlib import Path
from datetime import datetime

try:
    from dotenv import load_dotenv
    # Try loading from .env.local first, then .env
    env_local = Path(__file__).parent.parent / ".env.local"
    env_file = Path(__file__).parent.parent / ".env"
    if env_local.exists():
        load_dotenv(env_local)
    elif env_file.exists():
        load_dotenv(env_file)
except ImportError:
    pass

from supabase import create_client

SCRIPT_DIR = Path(__file__).parent
LOCAL_HISTORY = SCRIPT_DIR.parent / "email_history.json"

SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
    exit(1)

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


# ═══════════════ 核心: merge_person ═══════════════

def find_person_by_email(email):
    """查 emails 数组包含这个 email 的 person."""
    if not email:
        return None
    r = sb.table("persons").select("*").contains("emails", [email.lower()]).limit(1).execute()
    return r.data[0] if r.data else None


def merge_person(evidence, commit=False):
    """
    核心归并函数. evidence 字典支持的字段:
      emails, hf_users, github_users, arxiv_author_names: [..]
      real_name, first_name, affiliation, school_name, school_tier, bio
      last_outreach_at, last_outreach_source, outreach_count
      source_event: {source, repo/arxiv_id, found_at}

    返回: (person_id, action) — action 是 'created' 或 'updated'
    """
    emails = [e.lower().strip() for e in evidence.get("emails", []) if e]
    hf_users = [u.lower().strip() for u in evidence.get("hf_users", []) if u]
    github_users = [u.lower().strip() for u in evidence.get("github_users", []) if u]
    arxiv_names = [n.strip() for n in evidence.get("arxiv_author_names", []) if n]

    # 找已有 person
    existing = None
    for e in emails:
        existing = find_person_by_email(e)
        if existing:
            break
    if not existing:
        for h in hf_users:
            r = sb.table("persons").select("*").contains("hf_users", [h]).limit(1).execute()
            if r.data:
                existing = r.data[0]
                break
    if not existing:
        for g in github_users:
            r = sb.table("persons").select("*").contains("github_users", [g]).limit(1).execute()
            if r.data:
                existing = r.data[0]
                break

    now = datetime.utcnow().isoformat()

    if existing:
        # 合并
        merged_emails = list(set((existing.get("emails") or []) + emails))
        merged_hf = list(set((existing.get("hf_users") or []) + hf_users))
        merged_gh = list(set((existing.get("github_users") or []) + github_users))
        merged_arxiv = list(set((existing.get("arxiv_author_names") or []) + arxiv_names))

        source_events = existing.get("source_events") or []
        if evidence.get("source_event"):
            source_events = source_events + [evidence["source_event"]]

        update = {
            "emails": merged_emails,
            "hf_users": merged_hf,
            "github_users": merged_gh,
            "arxiv_author_names": merged_arxiv,
            "last_seen_at": now,
            "updated_at": now,
            "source_events": source_events,
        }
        for field in ("real_name", "first_name", "affiliation", "school_name", "school_tier", "bio"):
            if evidence.get(field) and not existing.get(field):
                update[field] = evidence[field]

        new_outreach = evidence.get("last_outreach_at")
        old_outreach = existing.get("last_outreach_at")
        if new_outreach and (not old_outreach or new_outreach > old_outreach):
            update["last_outreach_at"] = new_outreach
            update["last_outreach_source"] = evidence.get("last_outreach_source")
            update["outreach_count"] = (existing.get("outreach_count") or 0) + 1
            update["outreach_status"] = "contacted"

        if commit:
            sb.table("persons").update(update).eq("id", existing["id"]).execute()
        return existing["id"], "updated"

    else:
        # 新建
        new_person = {
            "emails": emails,
            "hf_users": hf_users,
            "github_users": github_users,
            "arxiv_author_names": arxiv_names,
            "real_name": evidence.get("real_name"),
            "first_name": evidence.get("first_name"),
            "affiliation": evidence.get("affiliation"),
            "school_name": evidence.get("school_name"),
            "school_tier": evidence.get("school_tier"),
            "bio": evidence.get("bio"),
            "first_seen_at": now,
            "last_seen_at": now,
            "updated_at": now,
            "source_events": [evidence["source_event"]] if evidence.get("source_event") else [],
        }
        if evidence.get("last_outreach_at"):
            new_person["last_outreach_at"] = evidence["last_outreach_at"]
            new_person["last_outreach_source"] = evidence.get("last_outreach_source")
            new_person["outreach_count"] = 1
            new_person["outreach_status"] = "contacted"

        if commit:
            r = sb.table("persons").insert(new_person).execute()
            return r.data[0]["id"], "created"
        return "dry-run-id", "created"


# ═══════════════ Step 1: email_contact_history → persons ═══════════════

def migrate_email_contact_history(commit):
    print("\n━━━ Step 1: email_contact_history → persons ━━━")
    offset = 0
    batch = 500
    total = 0
    created = 0
    updated = 0
    while True:
        r = sb.table("email_contact_history").select("*").range(offset, offset + batch - 1).execute()
        if not r.data:
            break
        for row in r.data:
            total += 1
            email = row.get("email")
            if not email:
                continue
            evidence = {
                "emails": [email],
                "last_outreach_at": row.get("contacted_at"),
                "last_outreach_source": row.get("source") or "arxiv",
                "source_event": {
                    "source": row.get("source") or "arxiv",
                    "paper_title": row.get("paper_title"),
                    "found_at": row.get("contacted_at"),
                },
            }
            _, action = merge_person(evidence, commit=commit)
            if action == "created":
                created += 1
            else:
                updated += 1
            if total % 100 == 0:
                print(f"  processed {total}: +{created} new, {updated} merged")
        offset += batch
        if len(r.data) < batch:
            break
    print(f"  ✅ total {total}: {created} created, {updated} merged")


# ═══════════════ Step 2: paper_authors (有 email 的) → persons ═══════════════

def migrate_paper_authors(commit):
    print("\n━━━ Step 2: paper_authors → persons ━━━")
    offset = 0
    batch = 500
    total = 0
    created = 0
    updated = 0
    skipped = 0
    while True:
        r = (
            sb.table("paper_authors")
            .select("*")
            .not_.is_("email", "null")
            .range(offset, offset + batch - 1)
            .execute()
        )
        if not r.data:
            break
        for row in r.data:
            total += 1
            email = (row.get("email") or "").strip()
            if not email:
                skipped += 1
                continue
            evidence = {
                "emails": [email],
                "first_name": row.get("first_name"),
                "real_name": row.get("author_name"),
                "arxiv_author_names": [row["author_name"]] if row.get("author_name") else [],
                "source_event": {
                    "source": "arxiv",
                    "arxiv_id": row.get("arxiv_id"),
                    "author_position": row.get("position"),
                    "found_at": row.get("created_at"),
                },
            }
            _, action = merge_person(evidence, commit=commit)
            if action == "created":
                created += 1
            else:
                updated += 1
            if total % 100 == 0:
                print(f"  processed {total}: +{created} new, {updated} merged")
        offset += batch
        if len(r.data) < batch:
            break
    print(f"  ✅ total {total}: {created} created, {updated} merged, {skipped} skipped")


# ═══════════════ Step 3: 本地 email_history.json → persons ═══════════════

def migrate_local_json(commit):
    print("\n━━━ Step 3: local email_history.json → persons ━━━")
    if not LOCAL_HISTORY.exists():
        print(f"  ⏭️  {LOCAL_HISTORY} not found, skip")
        return
    with open(LOCAL_HISTORY) as f:
        history = json.load(f)
    total = 0
    created = 0
    updated = 0
    for email, rec in history.items():
        total += 1
        evidence = {
            "emails": [email],
            "last_outreach_at": rec.get("date"),
            "last_outreach_source": "mailman227",
            "source_event": {
                "source": "mailman227_local",
                "paper": rec.get("paper"),
                "found_at": rec.get("date"),
            },
        }
        _, action = merge_person(evidence, commit=commit)
        if action == "created":
            created += 1
        else:
            updated += 1
        if total % 200 == 0:
            print(f"  processed {total}: +{created} new, {updated} merged")
    print(f"  ✅ total {total}: {created} created, {updated} merged")


# ═══════════════ Main ═══════════════

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="真正写入 Supabase (默认 dry-run)")
    ap.add_argument("--skip-history", action="store_true")
    ap.add_argument("--skip-authors", action="store_true")
    ap.add_argument("--skip-local", action="store_true")
    args = ap.parse_args()

    mode = "COMMIT" if args.commit else "DRY-RUN"
    print(f"🚀 migrate_to_persons.py [{mode}]")

    r = sb.table("persons").select("id", count="exact").limit(1).execute()
    print(f"📊 persons 表当前行数: {r.count}")

    if not args.skip_history:
        migrate_email_contact_history(args.commit)
    if not args.skip_authors:
        migrate_paper_authors(args.commit)
    if not args.skip_local:
        migrate_local_json(args.commit)

    r = sb.table("persons").select("id", count="exact").limit(1).execute()
    print(f"\n📊 migration done. persons 表现在行数: {r.count}")

    if not args.commit:
        print("\nℹ️  这是 dry-run,数据库没有真实写入")
        print("   满意后加 --commit 重跑")


if __name__ == "__main__":
    main()
