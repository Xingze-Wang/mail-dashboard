# Congress Architecture

The four-loop / four-horizon model. This is the canonical reference — when building or modifying any loop, check that the cadence, roster, and evidence-flow match this spec. If a proposal violates the structure, push back or update this doc; don't build sideways.

The discipline: each loop answers a question the others **can't**. Multiple loops at the same cadence with overlapping rosters is one congress with extra steps — collapse them.

---

## Loop 1: Daily — the Apprentice

**Cadence**: nightly
**Roster**: single agent (no debate)
**Job**: detect per-rep micro-patterns, surface them as Lark cards to the rep who created them
**Decision authority**: the rep, on themselves only
**Throughput target**: 10-30 micro-decisions / week across 5 reps
**Evaluation**: stop-loss after 30 sends; graduation candidate after 14 days + 50 sends

**Status (2026-05-03)**: ✅ shipped as JITR.
- `scripts/jitr-tick.mjs` — daily offer creator
- `scripts/jitr-stop-loss.mjs` — auto-revert + graduation proposer
- `src/lib/lark-agent.ts:processJitrCardAction` — accept/dismiss handler
- `migrations/038-jitr-offers.sql` — per-rep state with `applied_at`, `reverted_at`, `promoted_global_at`

**Why no congress**: nothing to deliberate. Rep accepts or doesn't. Reversibility is one click. Stop-loss watches the math.

---

## Loop 2: Weekly — the Tactical Congress

**Cadence**: Sunday night → lands Monday morning
**Roster**: Data Analyst, Copywriter, Academic Proxy, Sales Director, Synthesizer (+ Adversary as critic)
**Job**: propose A/B-testable or rule-level changes — subject line tests, template phrase swaps, routing tweaks within existing categories, landing-page copy edits
**Decision authority**: human admin (Xingze) approves 1-3 per week
**Measurable in**: 2-6 weeks
**Rollback**: revert the migration / template version
**Throughput target**: 1-3 approved changes / week

**Status**: 🔨 not built. Highest-priority next loop per advisor.

**Build prerequisites**:
- Each proposed change must carry `expected_lift` and `weeks_to_evaluate` so Loop 3's Historian can grade it
- Need a `tactical_proposals` table (status, proposer-personas, evidence-bundle JSON, expected_lift, weeks_to_evaluate, ship_decision, shipped_at, evaluation_due_at, actual_lift)

**Personas** (per advisor):
- **Data Analyst** — surfaces the metric movement that motivates the proposal
- **Copywriter** — owns the prose changes (templates, subject lines)
- **Academic Proxy** — speaks for the recipient researcher's perspective; reads sampled actual replies
- **Sales Director** — speaks for the rep's experience; reads helper bot conversations
- **Adversary** — attacks the proposal's premise. "What's the strongest reason this won't lift?"
- **Synthesizer** — produces the final written proposal: change spec + expected lift + evaluation criteria

---

## Loop 3: Monthly — the Strategic Congress

**Cadence**: first Monday of the month
**Roster**: Historian, Funnel Economist, Constituent Advocate, Adversary, Synthesizer
**Job**: structural changes — adding/removing arXiv categories, redefining tier thresholds, hiring rationale for new reps, killing distinctions that data doesn't support, expanding to new researcher communities
**Decision authority**: human admin, 0-1 approved per month (often zero)
**Measurable in**: quarters
**Rollback**: expensive

**Status**: 🔨 not built. Build only after ≥2 months of Loop 2 decisions exist for the Historian to grade.

**Different roster from Loop 2 — by design**:
- **Historian** — reads last 90 days of approved tactical decisions and their actual lift. Grades Loop 2's homework. Did we ship 12 changes that net-zeroed?
- **Funnel Economist** — looks at the entire funnel as a unit. Identifies which stage is actually the bottleneck. "We're optimizing email click-rate but the bottleneck is WeChat-add."
- **Constituent Advocate** — broader than Academic Proxy: speaks for both researcher AND rep as humans, not as conversion targets
- **Adversary** — attacks proposed STRATEGIC changes. "You want cs.NE — do you have evidence neuroevolution Chinese researchers exist in volume?"
- **Synthesizer** — same role

**Notably absent**: no Copywriter (irrelevant at this altitude). Strategic congress doesn't argue about phrases.

---

## Loop 4: Quarterly — the Postmortem Congress (conditional)

**Cadence**: only when triggered by a metric crossing a threshold:
- Overall conversion drops >20% from rolling baseline, OR
- A rep's individual conversion drops >2σ for 3+ weeks, OR
- A direction's CVR collapses

**Roster**: Historian, Adversary, Causal Investigator
**Job**: forensic analysis of why something broke. Backward-looking, NOT forward-looking.
**Output**: a narrative + evidence timeline. Not a decision package.
**Feeds**: standing context for next Loop 3 (and all loops) until issue resolved.

**Status**: 🔨 not built. Build only if/when something breaks.

**Most quarters this loop doesn't fire — that's correct.** When it does, it's the most important meeting of the year.

---

## How the loops connect (the make-or-break part)

Without these links, the four loops become four cron jobs that never inform each other.

| Link | What flows | Where it lives |
|---|---|---|
| Daily → Weekly | If 3+ reps independently accepted the same drift pattern, that's a Copywriter agenda item for Loop 2. Daily produces signal; weekly deliberates on whether it generalizes. | Query: `jitr_offers WHERE decision='accept' GROUP BY pattern semantics, count distinct rep_id ≥3` |
| Weekly → Monthly | Every approved tactical change carries `expected_lift` + `weeks_to_evaluate`. Historian receives the cohort whose evaluation window completed. **Tactical congress accountability happens at the monthly tier** — a system that grades its own homework grades generously. | `tactical_proposals.evaluation_due_at <= now() AND graded_at IS NULL` |
| Monthly → Weekly | Strategic decisions become CONSTRAINTS on next 4 weekly congresses. Without this link, monthly decisions are theater. | `strategic_directives` table; Loop 2 system prompt includes active directives |
| Postmortem → all | Forensic findings become standing context until issue resolved. | `incident_lessons` table; included in every loop's system prompt while `resolved_at IS NULL` |

---

## Build order (per advisor)

1. **Loop 1 (Daily)** — already shipped (JITR)
2. **Loop 2 (Weekly)** — build next. Where you have enough volume for non-trivial output and where the design is most novel.
3. **Loop 3 (Monthly)** — only after ≥2 months of Loop 2 decisions exist for Historian to grade
4. **Loop 4 (Postmortem)** — only when something actually breaks

**Don't build all four at once.** Each loop earns the next.

---

## Anti-patterns to refuse

- **Same cadence + overlapping roster** = one congress with extra steps. Collapse them.
- **Per-surface congresses** ("congress for email, congress for landing, congress for routing") = recreates the analyst-per-table problem. Surfaces interact; debate the interactions in one place.
- **Sliding the cadence** — letting weekly become biweekly because nothing happened, or monthly become quarterly because it's slow. The cadence is the forcing function. Knowing the Historian grades you in 4 weeks is what makes the tactical congress propose evaluable changes instead of vague directional ones.
- **Loop graded by itself** — never. Always graded by the next loop up.
- **Letting strategic decisions stay theater** — every approved Loop 3 decision MUST land in `strategic_directives` and MUST appear in Loop 2's system prompt for the next ≥4 weeks. If we approve "target cs.NE" and Loop 2 never sees it, we silently abandoned the decision.

---

## One-sentence version

- **Daily**: apprentice watches reps edit drafts, asks "want me to remember this for you?"
- **Weekly**: five personas argue about what to ship next, one human approves three things
- **Monthly**: historian grades last quarter's decisions, economist asks if we're optimizing the right thing
- **Quarterly (conditional)**: when something breaks, build the timeline before deciding what to change

Four loops, four time horizons, four different jobs, one shared evidence graph in Postgres.
