# Updated Sales Assignment Rules (binding spec)

The user clarified the classification logic. Use these EXACT rules — they override anything in the original prompt.

## Tier classification (strong vs normal)

A lead is **Strong** if EITHER:
- `citation_count > 2000`, OR
- `school_tier IN (1, 2)` (tier 1 or 2 school)

Otherwise: **Normal**.

This means `classifyLead()` in `src/lib/assignment.ts` should be:
- If hIndex/citation/school data is missing → default to Normal (don't gate strong on h-index alone)
- The current `min_h_index: 20` config field is OBSOLETE for this rule. Replace `strong_criteria` with `{ min_citation: 2000, max_school_tier: 2 }`.

## Rep assignment (after tier is decided)

- **Strong** → Leo (rep_id 1)
- **Normal + overseas** (email domain does NOT end with `.cn`) → Ethan
- **Normal + domestic** (email domain ends with `.cn`) → Chenyu

This means:
- No more round-robin
- No more category-based routing — drop `category_routing` entirely from the default config
- `assignRep()` becomes a flat 3-way decision: strong → Leo, normal+overseas → Ethan, normal+domestic → Chenyu

## What this means for your work

1. **Update `getAssignmentConfig()` defaults** in `src/lib/assignment.ts`:
   ```typescript
   {
     strong_criteria: { min_citation: 2000, max_school_tier: 2 },
     assignment: {
       strong: { rep_id: <Leo's id> },
       overseas: { rep_id: <Ethan's id> },
       domestic: { rep_id: <Chenyu's id> },
     },
   }
   ```

2. **Update the `AssignmentConfig` TypeScript interface** to match — drop `normal.rep_ids`, drop `overseas_override`, drop `category_routing`.

3. **Rewrite `classifyLead()`**:
   ```typescript
   export function classifyLead(config, lead) {
     if ((lead.citationCount ?? 0) > config.strong_criteria.min_citation) return "strong";
     if (lead.schoolTier !== null && lead.schoolTier <= config.strong_criteria.max_school_tier) return "strong";
     return "normal";
   }
   ```
   (Note `citationCount` not `hIndex`. Add the field to the lead param if missing.)

4. **Rewrite `assignRep()`**:
   ```typescript
   export function assignRep(config, tier, authorEmail) {
     if (tier === "strong") return config.assignment.strong.rep_id;
     return isOverseas(authorEmail) ? config.assignment.overseas.rep_id : config.assignment.domestic.rep_id;
   }
   ```

5. **Drop `matchedDirections` parameter** from `assignRep()` calls — category routing is gone. Find callers (grep `assignRep(`) and remove that arg.

6. **Drop `resolveCategory()`** if nothing else uses it (grep first).

7. **Sales tab "category coverage" section** — REMOVE that requirement from the original prompt. Instead show a simpler 3-rep ownership card:
   - Leo: Strong leads (citation > 2000 OR tier ≤ 2)
   - Ethan: Normal leads, overseas (.com / .edu / etc)
   - Chenyu: Normal leads, domestic (.cn)

8. **Settings page rep CRUD** — keep, but the "category routing" UI (if you added any) should be removed since routing is now strictly tier+geo.

9. **Migration** — confirm the seed inserts in `migrations/003-add-ethan.sql` covers ALL THREE reps if any are missing. Check current sales_reps table content; if Chenyu doesn't exist, add a seed too. Use these defaults:
   - Chenyu: name='Chenyu', sender_email='chenyu@compute.miracleplus.com', sender_name='Chenyu', wechat_id='chenyu_wechat_TBD' (call out for user to fill)
   - Ethan: name='Ethan', sender_email='ethan@compute.miracleplus.com', sender_name='Ethan', wechat_id='hnyhc5'

10. **Re-run `/api/config/assignment` POST after applying the migration** to re-classify and re-assign every existing lead with the new rules.

## Verify rule correctness

After your changes, write a tiny test/sanity check (could be a one-shot route or just run via dev server console):
- A lead with citation_count=3000, .edu email, hIndex=null → strong → Leo
- A lead with school_tier=1, .cn email → strong → Leo
- A lead with citation_count=500, school_tier=4, .stanford.edu email → normal+overseas → Ethan
- A lead with citation_count=500, school_tier=4, .tsinghua.edu.cn email → normal+domestic → Chenyu
