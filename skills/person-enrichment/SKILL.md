---
name: person-enrichment
description: Resolve a researcher's HuggingFace + GitHub + real name + affiliation from just an email. Use when an unknown person enters our pipeline and we need to dedup against existing contacts before outreach. Verification (≥2 independent signals) is the load-bearing rule — wrong links are worse than no links.
---

# Person Enrichment Skill

## Why this skill exists

We have a `persons` table that anchors the dedup gate for cold outreach. When a new lead arrives — from arxiv, HuggingFace, manual import, anywhere — we need to know: have we contacted this person before, even under a different email or handle?

The job: given an email (and sometimes a paper / name / affiliation hint), find their public HF + GitHub handles + real name + affiliation, and write back to `persons` so future dedup catches them.

**The single most important rule: a wrong link is worse than no link.** A wrong link causes (a) a future cold email to skip them when it shouldn't, or (b) a separate person to inherit their identity. Both are silent + bad. Slow + accurate beats fast + noisy.

## The name-match floor (read this first)

**If the surname character doesn't match, it is not the same person. Period.**

Pinyin collisions across Chinese surnames are everywhere — 杨/姚/羊 all romanize "Yang"; 严/颜/燕/晏/阎 all romanize "Yan"; 金/钦/靳/晋 all read "Jin". When the input has Chinese characters and the candidate page does not show the *same characters*, you have not verified the person — you have verified a homonym.

Hard rules:

1. **Character-level surname match required.** Input `杨吉凯` cannot match candidate `Jikai Jin / 金继凯` even if both are CS researchers — the surname character is different. Reject immediately, do not pass go.
2. **Pinyin alone is never a signal for Chinese names.** "Shuo Yang at university X" is not a match for `杨硕` unless the page explicitly shows `杨硕` (or the institution publishes a Chinese-language faculty page where the chars appear).
3. **Common given names amplify the trap.** `杨硕` (Shuo Yang) has dozens of researcher-aged carriers. Finding *one* page that matches char-for-char is necessary but not sufficient — you also need a *disambiguating* signal that rules out the others (current institution from a recent source, advisor name, a paper from the lead's known field).
4. **The "wrong person passed two signals" failure mode.** Real example: `杨硕` → an agent found Shuo Yang at Shenzhen MSU-BIT with personal homepage *and* GitHub profile *and* recent papers, all char-matched. Two signals satisfied. Wrong person — the actual `杨硕` is at UC Berkeley. The signals confirmed *a* Shuo Yang, not *the* Shuo Yang. Mitigation: when the input is just a Chinese name with no other anchor (no email, no paper, no school), and multiple char-matched candidates exist, **report the ambiguity rather than picking one**.

When you have only a Chinese name (e.g., a do-not-contact entry) with no email/affiliation/paper hint, the bar is much higher: you need an *exclusive* identifier (homepage that is *uniquely* this person, like a custom domain whose owner is on record, or an institutional email that only one person could hold). Otherwise: skip-fast.

## The verification rule

Auto-write to `persons.hf_users` / `github_users` / `real_name` / `affiliation` ONLY when you have **2 independent signals** that the value is right AND the surname character matches AND no other char-matched candidate exists with similar plausibility. One signal alone goes to `person_enrichment_candidates` for human review.

Examples of independent signal pairs that have worked:

| Signal A | Signal B | Verdict |
|---|---|---|
| Personal site at `<user>.github.io` lists target email | GitHub user `<user>` exists with matching display name | ✅ verified |
| HF profile fullname matches lead's name | HF user is member of the lead's institution org (e.g. `KingsCollegeLondon`) | ✅ verified |
| arxiv paper hint matches an arxiv author with linked GitHub | That GitHub user's commit history contains lead's email | ✅ verified |
| Personal site exists | Site lists target email + same GitHub username via mailto:/link | ✅ verified |
| Personal site exists with `<script type="application/ld+json">` `sameAs` array linking GitHub + scholar + HF | Names align across all entries | ✅ verified |
| Email prefix matches GitHub username | (no second signal) | ⚠️ candidates only — username collisions are common |
| Common name + same institution | (no second signal) | ⚠️ candidates only — multiple "Yan Song"s at USTC, multiple "Y. Wang"s at Tsinghua exist |

## Strategies (proven on real runs)

These are the moves that produced the highest verified-write rates in pilot dispatches.

### 1. `<username>.github.io` is gold

A personal homepage at `<x>.github.io` proves account ownership of GitHub user `<x>` (only that account can publish to that subdomain). If the page also lists the target email, that's two signals in one move.

Cheap to check: just fetch `<email_prefix>.github.io` and `<email_prefix>-<institution>.github.io` and see what loads.

### 2. HF org membership confirms institutional researchers

HuggingFace orgs are gatekept — admins approve members. So `huggingface.co/api/users/<X>/overview` returning an `orgs` array containing the lead's institution (e.g. `KingsCollegeLondon`, `BackdoorLLM` for a known security researcher) is a stronger signal than a fullname match alone.

```bash
curl -s https://huggingface.co/api/users/{username}/overview | jq '{fullname, orgs}'
```

### 3. Schema.org `sameAs` arrays on academic homepages

Some faculty homepages embed:

```html
<script type="application/ld+json">
{ "@type":"Person", "name":"...", "sameAs":["github.com/x", "huggingface.co/y", ...] }
</script>
```

When present, this is near-instant verification — explicitly listed cross-platform handles.

### 4. GitHub commit-email search (when API isn't rate-limited)

```
https://api.github.com/search/commits?q=author-email:<email>
```

Gold standard when it works. Often rate-limited; fall back to other strategies if 403/429.

### 5. arxiv hint + Semantic Scholar bridge

If we have an arxiv paper that surfaced this person, the arxiv author page sometimes has explicit GitHub/HF links. Failing that, Semantic Scholar's author search can bridge name + affiliation to S2 author profile, which sometimes has a homepage URL.

### 6. Don't forget the inverse: HF / GitHub bio → email

Many HF/GitHub users put their real email in their bio or commit history. If you've identified a candidate handle, **fetch the user's events/commits and search for the lead's email** — direct confirmation.

## When to skip fast (don't burn the budget)

The pilot's failure modes were consistent. If you see any of these, write `couldnt_find` and move on within 30 seconds:

- **Opaque student email**: numeric IDs (`xpr820@pku.edu.cn`, `122090863@cuhk.edu.cn`, `hebx24@mails.tsinghua.edu.cn`). The prefix carries no name signal.
- **Generic personal Gmail with no paper hint**: `lzcthu12@gmail.com` — no public footprint to follow.
- **Corporate alias at non-research company**: `xiaohanyang@pinterest.com`, `zhanlun@360.cn` — usually no public researcher trail.
- **Common Chinese name at large institution**: 5+ "Y. Wang" at Tsinghua. Without a second signal you'll false-merge.
- **Junior student at Chinese military / elite school**: `chenluanrong@nudt.edu.cn`, lab page restricted. ~Zero public footprint.

These were the persistent ~40% of cases where the answer is genuinely "not findable from open web." Don't waste 5 minutes confirming it; report and move on.

## How to be honest about confidence

Confidence score guide:

- **0.95–1.0**: 3+ strong signals (e.g., personal site + scholar + HF org membership)
- **0.85–0.94**: 2 strong independent signals
- **0.70–0.84**: 1 strong + 1 weak signal
- **0.50–0.69**: 1 strong signal alone (goes to candidates, not auto-write)
- **<0.50**: don't include — leave the field out

If you find yourself reaching to justify a score, it's too low. Be ruthless. **Stale GitHub bios are a known trap** — a GitHub user's bio listing PhD school is not their current affiliation. Always cross-check current affiliation via Google Scholar / personal site / faculty directory.

## Output format (when used inside an agent dispatch)

Return JSON, one entry per person:

```json
{
  "person_id": "uuid",
  "email": "their@email.com",
  "proposals": {
    "real_name": { "value": "Wei Zhang", "confidence": 0.95, "evidence": ["faculty page X", "scholar profile Y"] },
    "affiliation": { "value": "Tsinghua University", "confidence": 0.95, "evidence": ["..."] },
    "hf_users": [{ "value": "weizhang-thu", "confidence": 0.85, "evidence": ["...", "..."] }],
    "github_users": [{ "value": "wzhang-thu", "confidence": 0.90, "evidence": ["...", "..."] }]
  },
  "couldnt_find": ["hf_users"]
}
```

Omit fields you didn't find. Evidence should be specific (URLs are best).

## Cross-check via reconcile

When dispatching multiple agents on the same slice for cross-verification:
- 2+ agents agree on the same value (avg confidence ≥ 0.7) → write to `persons`
- Agents propose different values for the same field → flag both for review
- Only 1 agent reports a value (no second voice) → candidate row only

The reconcile script (`scripts/agent-runs/reconcile.mjs`) implements this.

## Try harder (but not blindly)

Before giving up on a person, try at least 3 different angles:

1. Quoted email Google search → `"<email>" site:github.com`
2. Email prefix as username on HF + GitHub → `huggingface.co/<prefix>`, `github.com/<prefix>`
3. If paper hint present: arxiv author page → linked GitHub/HF
4. If institution clear: faculty directory + Google Scholar
5. Personal site discovery: `<prefix>.github.io`, `<prefix>.com`, `<name>.github.io`

If none of those produce a signal, then skip. But "I tried 1 thing and it didn't work" is too eager a quit.

## Failure modes to watch for in your own work

- **Pinyin-collision trap (the worst one)**: `杨吉凯` and `金继凯` both pinyin to "Jikai (Y/J)". An agent that confirms via pinyin without char-checking the surname will silently attach the wrong person's email. **Always char-match the surname first.** If the candidate page does not show the *exact* Chinese characters of the input name, it is not a match — no matter how many other signals line up.
- **Confirming-not-disambiguating**: two signals can confirm that *a* "Shuo Yang" exists at university X (homepage + GitHub both showing 杨硕), without ruling out that the *real* `杨硕` we want is a different `杨硕` at university Y. When the input has no anchor beyond a name, finding *one* match is not enough — you need to actively rule out the alternates.
- **Eager-matching common names**: "Wei Zhang at Tsinghua" matches dozens of real people. Without a disambiguating signal, you'll merge the wrong one.
- **Stale-bio trust**: a GitHub user's company field can be 5 years old.
- **Username-prefix collisions**: `<email_prefix>` matching a HF/GitHub username is one signal, not two. They're often coincidentally different people.
- **Org-membership over-trust**: HF orgs are admin-approved but some accept any researcher who applies. A `Tsinghua-NLP` org member could be a visiting researcher, not faculty.

## When budget is constrained

LLM/agent budget is shared at the org level. Burning 30 agents in parallel on hard cases without giving each one a clear path to a fast answer wastes budget. Prefer:

- **API-first** (HF, GitHub, Semantic Scholar) — cheap, deterministic
- **Browser-fetch as fallback** for the long tail (~5% of leads where APIs returned nothing useful)
- **Skip-fast on the unenrichable patterns above** — saves the budget for the leads that actually have a public footprint

A run that completes 60 leads at 50% verified is better than one that completes 30 leads at 80% verified and crashed mid-batch.
