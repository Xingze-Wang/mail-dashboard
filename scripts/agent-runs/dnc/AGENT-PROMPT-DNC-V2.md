# DNC Email Hunt — V2 (with char-match floor)

You are searching for the verified email of one specific person on the do-not-contact list. You have full WebFetch / WebSearch / Bash access. **Use it freely.** No permission asks needed; the user has explicitly authorized.

## The 44 names already had a v1 pass — most were skip-fast on common-name disambiguation. This pass is targeted: each agent gets ONE name + a hint from the user.

## HARD RULES (read carefully — v1 had real failures here)

### Rule 0: Surname character must match exactly
- Input `杨吉凯` (surname 杨, "Yang") cannot match candidate `Jikai Jin / 金继凯` (surname 金, "Jin"). Different surname char = different person, full stop. Pinyin is not a signal.
- Pinyin collisions: 杨/姚/羊 → "Yang"; 严/颜/燕/晏/阎 → "Yan"; 金/钦/靳 → "Jin". The candidate page MUST show the exact input characters. If it shows only pinyin or English-name + a *different* surname char, REJECT.

### Rule 1: Two independent signals AFTER char-match
After confirming surname char matches, you still need 2 independent signals confirming the candidate is THIS person (not a different person who also has these chars). Examples that count:
- (a) Personal site at `<x>.github.io` carrying input chars + (b) GitHub user `<x>` profile name field showing "Shuo Yang 杨硕"
- (a) Institutional faculty page char-matched + (b) cross-confirmed via Google Scholar verified-email domain
- (a) Personal site + (b) recent (last-30d) public activity using same identity (paper, post, recruiting notice)

### Rule 2: Confirming ≠ Disambiguating
Finding ONE char-matched candidate is necessary but not sufficient. If multiple distinct people share the exact chars (common with 王洋, 张子豪, 高俊, 杨硕), and the input has no other anchor, you must rule out alternates OR skip. The v1 failure mode: agent found `杨硕` at Shenzhen MSU-BIT with homepage + GitHub + char match — but the actual `杨硕` we wanted is at UC Berkeley (different person, same characters). Two signals confirmed *a* 杨硕, not *the* 杨硕.

### Rule 3: Last-30-days activity required
After identity is confirmed, the account must have public activity in the last 30 days (commits, papers, posts, recruiting notices, talks, AC roles). Stale identity = skip. The DNC list is for active people; an old identity match for someone who's gone dark is more likely a stale account collision.

### Rule 4: Better empty than wrong
Wrong email on a DNC record means the real person leaks through dedup and we cold-email them anyway. The DNC error mode is bad too. When in doubt → skip.

## Output format

Write to `scripts/agent-runs/dnc/v2-{NAME_PINYIN}.json`:

```json
{
  "real_name": "input chars",
  "person_id": "uuid from input",
  "email": {
    "value": "verified@example.com",
    "confidence": 0.0-1.0,
    "evidence": ["URL: what it confirms", "URL: what it confirms", ...]
  },
  "couldnt_find": false_or_true,
  "notes": "char-match check + disambiguation reasoning + 30d activity"
}
```

Or if not found:
```json
{
  "real_name": "input chars",
  "person_id": "uuid",
  "couldnt_find": true,
  "notes": "what you tried + why you stopped"
}
```

## Search angles

1. Quoted Chinese chars + 2026 + (institution hint or topic)
2. HuggingFace API: `https://huggingface.co/api/users/{guess}/overview` returns fullname/orgs
3. GitHub API: `https://api.github.com/users/{guess}` — name field often has chars
4. Personal site discovery: `<pinyin>.github.io`, `<pinyin>.com`, `<pinyin>.cn`
5. Google Scholar profile (verified-email domain hint)
6. Institutional faculty pages (Tsinghua, Berkeley, Westlake, MSKCC etc. — use Chinese-language pages where chars are explicit)

## Try harder before giving up

If first 3 angles fail, try:
- arxiv search by Chinese characters (recent papers list authors with chars)
- LinkedIn (sometimes has Chinese chars)
- Lab pages (research group member listings often pair English + Chinese names)
- Cross-confirm via two of: Scholar verified-email domain + faculty page email + homepage email

If still nothing after ~10 fetches: skip-fast with notes explaining what you tried.
