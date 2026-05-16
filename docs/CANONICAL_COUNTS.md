# Canonical counts — single source of truth for every number

**TL;DR**: every numeric count surfaced to users — UI cards, `/api/*`
responses, bot answers, briefs, cron DMs — must flow through
`src/lib/canonical-counts.ts`. If you find yourself writing a
`count: "exact"` query or a `leads.length` aggregation outside that
file, you are about to add a future bug.

---

## Why this exists

On 2026-05-16 the `/pipeline` page showed:

- **"1,000 active leads"** in the page subtitle
- **"Total leads: 3,081"** in a card on the same screen

The subtitle was computing `leads.length` from a paginated array that
silently capped at 1,000 (PostgREST's default row limit when you call
`.select(...)` without `count: "exact"`). The card was running a real
DB count. Two paths to the same answer disagreed by 3×.

Before canonical-counts, **46 distinct call sites** were each computing
the same underlying counts (leads, replies, sends, conversions) with
subtly different predicates and scoping. Every new feature added a new
inline `.from("pipeline_leads").select(...)` and the chance of
agreement was strictly less than 1.

Canonical-counts collapses those 46 sites onto one set of primitives,
guards the contract with a lint script, and gives any number on the
site a single path to debug.

---

## The contract

> Every numeric thing the user sees flows through
> `src/lib/canonical-counts.ts`.

Concretely:

1. **Counts**: always `{ count: "exact", head: true }`. Never
   `.select(...).length` after a paginated fetch — that silently caps
   at the PostgREST default.
2. **Bulk fetches**: always `.range(cursor, cursor + 999)` paginated.
   The `fetchAll*` helpers loop until exhausted.
3. **Every primitive returns the predicate it built** alongside the
   number — so a consumer can `console.log(result.predicate)` and
   reproduce the count by hand when something looks off.
4. **Status constants** come from `src/lib/status.ts`. Do not hand-roll
   `["sent", "replied"]` arrays at call sites.
5. **Read-only**. Canonical-counts never writes.

---

## The primitives

```ts
import {
  countLeads,                  // count pipeline_leads matching a filter
  countLeadsByStatus,          // full status breakdown + contacted/replied
  countReadyQueue,             // sendable vs ripening split
  fetchAllLeads,               // paginated, returns rows + total
  countSent,                   // count emails (outbound)
  countReplies,                // count inbound_emails (with thread fallback)
  countWechatConversions,      // count brief_lookups
  getThreadIdsForRep,          // helper: resolve sent threads for a rep
  invalidateCanonicalCountsCache,
} from "@/lib/canonical-counts";
```

Each primitive accepts a typed filter shape (`LeadFilter`, `EmailFilter`,
`ReplyFilter`, `WechatFilter`). All filter fields are optional — no
filter = global.

```ts
// "How many ready leads does Yujie have right now?"
const { count } = await countLeads({ repId: 2, status: "ready" });

// "Show me the strong-tier breakdown so far this week"
const { byStatus, contacted, total } = await countLeadsByStatus({
  tier: "strong",
  since: weekStart,
});

// "Today's sendable vs ripening for the current rep"
const { sendable, ripening, total } = await countReadyQueue({ repId });

// "Unread replies for rep, with thread-id fallback for legacy rows"
const threadIds = await getThreadIdsForRep(repId, senderEmail);
const { unread } = await countReplies({ repId, threadIds, isRead: false });
```

A 30-second in-memory cache fronts every call. Bypass with
`{ cache: false }` after writes.

---

## When to add a new primitive

A primitive belongs in canonical-counts when **at least two surfaces
need the same shape**. If you're the first consumer, write the query
inline at your call site with a `// canonical-counts:ignore` comment
and a one-line reason. When the second consumer shows up, promote it
into the module.

Two surfaces is the threshold because:

- Premature abstraction (1 caller) bakes in the wrong shape and forces
  rewrites once a second caller appears.
- Postponed abstraction (3+ callers) means at least one of them has
  already drifted and is now subtly wrong.

---

## When NOT to use canonical-counts

There is exactly one legitimate exception: **bulk-fetch-and-bucket**.

If a route needs `N rows × M metrics` (e.g. team-overview shows 7 reps ×
6 metrics = 42 numbers), calling `countLeads()` per cell would cost
42 round trips. Instead, fetch all rows once and bucket in JS:

```ts
// canonical-counts:ignore — bulk fetch + JS bucket pattern. Migrating
// to canonical-counts would mean 42 RTTs instead of 1. When a second
// dashboard needs the same bulk shape, add countLeadsByRep() and
// migrate both. See CANONICAL_COUNTS.md.
const { data: leads } = await supabase
  .from("pipeline_leads")
  .select("assigned_rep_id, status, lead_tier")
  .in("assigned_rep_id", repIds);
```

The `// canonical-counts:ignore` directive (placed on the line directly
above the offending `.from(...)`) opts out of the lint. **Every opt-out
must include a one-line reason.**

Other legitimate ignores:

- **Specialized attribution**: `from ilike '%email%'` for historical
  email rows that don't have `actor_rep_id` populated. Canonical-counts'
  `EmailFilter` doesn't model this; widen the filter when a second
  consumer appears.
- **Scorer / backfill scripts**: one-off ETL that reads whole tables.
  Not user-visible. Allow-listed by path prefix in `lint-counts.mjs`.
- **Integrity / debug routes**: bulk audits and probes, not KPIs.
- **Duplicate-message guards**: internal sentinels, not displayed counts.

---

## How to debug a number mismatch

Three steps. If the answer isn't here, the count isn't going through
canonical-counts.

### 1. Find both call sites

```bash
# Where does the number on screen come from?
rg "totalLeads|arxivTotal|readyCount|sentCount" src/
```

### 2. Log the predicate from each

Every canonical-counts primitive returns `{ count, predicate }`. Add a
temporary `console.log(predicate)` and trigger both surfaces:

```ts
const result = await countLeads({ repId, status: "ready" });
console.log("DEBUG predicate:", JSON.stringify(result.predicate));
console.log("DEBUG count:", result.count);
```

Diff the two predicates. The mismatch is always in there.

### 3. Reproduce by hand

Open Supabase SQL editor, run the predicate as a literal SQL query, and
confirm which side matches reality:

```sql
SELECT count(*) FROM pipeline_leads
WHERE assigned_rep_id = 2 AND status = 'ready';
```

If both sides match each other and disagree with reality, you've found
a write-side bug, not a read-side one — check the cron / webhook /
import path that should have updated the column.

---

## Enforcement

Two layers:

### Lint (CI)

`npm run lint:counts` blocks any new `.from("pipeline_leads") /
"emails" / "inbound_emails" / "brief_lookups"` with `count: "exact"`
outside `src/lib/canonical-counts.ts`.

The script (`scripts/lint-counts.mjs`) is wired into CI via the
`lint:counts` package script. Path-prefix allow-lists carry one-line
reasons; per-call opt-outs use `// canonical-counts:ignore`.

### Doc (this file)

Linked from `CLAUDE.md` under "Where to look first → Counts and metrics".
Anyone touching a count-producing surface should land here first.

---

## Migration log

| Surface | Status | Notes |
|---|---|---|
| `/api/pipeline/analytics` | migrated | Was the source of the 1000-cap bug |
| `/api/pipeline` (list) | migrated | Count goes through canonical, list stays inline |
| `/pipeline` page | migrated | Now uses `data.total` from API, not `leads.length` |
| `/api/pipeline/ready-count` | migrated | Uses `countReadyQueue` |
| `/api/admin/team-overview` | bulk-fetch (ignored) | N×M dashboard pattern — see "When NOT to" |
| `/api/metrics` | migrated | `countLeadsByStatus` + `countWechatConversions` |
| `/api/metrics/me` | migrated | Same |
| `/api/help/opening` | migrated | Daily opener |
| `/api/cron/standup` | migrated | 9am DM |
| `/api/cron/daily-rep-brief` | migrated | Dropped the `.limit(50)` activity slice |
| `/api/inbox/unread-count` | migrated | Now uses same scope as `/api/inbound` list |
| `helper-read-tools.ts` (`get_lead_counts`, `get_my_overview`) | migrated | Bot answers and UI tiles agree by construction |
| Scorer / backfill / integrity / admin reports | allow-listed | Bulk-fetch patterns, not user-visible counts |

---

## Future work

When demand for the following shapes appears in a second place, promote
them into canonical-counts and migrate the existing inline call:

- **`countLeadsByRep(repIds, filter)`** — returns `Map<repId, count>` in
  one round trip. Would let `team-overview` drop its inline pattern.
- **`countSentBySenderEmail(senderEmail, filter)`** — for the historical
  attribution path that `from ilike '%email%'` covers today.
- **`countLeadsByGeo(filter)`** — bulk geo bucket without paginating all
  rows. Would need a Postgres function or materialized view.

These aren't built yet because YAGNI — but the contract makes adding
them easy: write the primitive, migrate both callers in one commit,
delete the inline patterns.
