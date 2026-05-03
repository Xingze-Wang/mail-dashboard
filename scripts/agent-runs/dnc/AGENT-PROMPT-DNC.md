# DNC Email Hunt — Per-Name Search

You will get a small slice (2-3 names) of Chinese researchers/founders we want to flag as **do-not-contact**. They already exist in our `persons` table (with `real_name` set, `outreach_status='do_not_contact'`, but no email). Your job: try to find an email for each, but **only attach if you can verify it's the right person**.

## Hard rules

1. **DO NOT write to the database.** Output JSON to the path you're given. That's it.
2. **2 independent signals required** to attach an email. Single-signal = candidate, not auto-write.
3. **The "last 30 days" verification rule (this is the load-bearing rule):** before attaching an email, prove the account is *currently active* and matches the person. Specifically — find at least one of:
   - A commit, paper, blog post, or social post from this person in the last 30 days
   - A recent (last 30 days) profile update on a faculty/lab page where this email is listed
   - A 2024-2025 publication where this email is the corresponding-author email
   This rules out stale accounts (e.g., a "王洋" GitHub account dormant since 2018 that happens to share the name).

## Why this matters

Wrong email attached to a DNC person → the dedup gate skips a real person we DID want to email. Worse than no email. Better to leave email empty and rely on the name-match path.

## Strategies

- Quoted-name Google search: `"杨林易" 2025` or `"杨林易" github` — the year filter forces recency
- GitHub user search by display name → check last commit date (must be within 30d)
- Google Scholar profile → check last paper year (must be 2024 or 2025)
- LinkedIn / personal site → look for "current" affiliation language + last post date
- Pinyin variations: 杨林易 → "Linyi Yang", "Yang Linyi", "L. Yang"
- WeChat / Zhihu profiles surfaced via Baidu often have recent activity

## When to skip

- Common name (e.g. 王洋, 张子豪, 高俊) with no disambiguating signal — too many candidates, can't verify
- Only stale matches found (last activity > 60 days ago) — likely wrong account
- Multiple plausible candidates with no way to choose — flag both as candidates, don't auto-attach

## Output format

JSON array, one entry per name in your slice:

```json
{
  "real_name": "杨林易",
  "person_id": "uuid-from-input",
  "email": {
    "value": "linyi@example.com",
    "confidence": 0.85,
    "evidence": [
      "GitHub commit on 2026-04-15 with author email linyi@example.com",
      "Personal site linyi.dev (last updated April 2026) lists this email"
    ]
  },
  "couldnt_find": false,
  "notes": "Active researcher, last commit 2 weeks ago"
}
```

If you can't find an email at high confidence:
```json
{
  "real_name": "王洋",
  "person_id": "...",
  "couldnt_find": true,
  "notes": "Too common — found 12 plausible candidates, no way to disambiguate"
}
```

## Confidence floor

- 0.9+: 2 strong signals + recent activity confirmed
- 0.7-0.89: 2 signals but one is weaker (e.g., personal site mentioned but not directly verified)
- 0.5-0.69: 1 strong signal (single-source) — record but flag as low-conf
- <0.5: don't include; output `couldnt_find: true`

Keep it under 5 minutes per person. If you're searching for 5+ minutes with no disambiguating signal, skip.
