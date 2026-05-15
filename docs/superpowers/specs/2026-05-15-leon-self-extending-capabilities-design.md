# Leon Self-Extending Capabilities — Design

**Date:** 2026-05-15
**Status:** Design
**Author:** Xingze + Claude
**Related:** `src/lib/lark-agent.ts`, `src/lib/helper-tools.ts`, `src/lib/helper-read-tools.ts`, `src/lib/helper-learnings.ts`

## Problem

Leon (the Lark bot) cannot grow. Every capability is a hand-coded TypeScript case in `helper-read-tools.ts`. When a rep asks Leon to do something outside its ~50-tool catalog, Leon either fakes it, escalates to admin, or — most often — produces a generic chat reply when the rep wanted action. Two concrete failures the user has hit:

1. **Doc editing is impossible.** Leon has `create_lark_doc`, `create_rich_lark_doc`, and `append_to_lark_doc`. There is no `read_lark_doc`, no `replace_block`, no `delete_block`. So when a rep says "shorten section 2" or "this doc is ugly, fix it," Leon has no mechanical path to revise — only to create a new doc or append junk to the end.
2. **Capability gaps are permanent.** When Leon hits a wall (no tool exists for what the rep asked), the only outcomes are escalate-to-admin or fail silently. The next time the same ask comes in, Leon hits the same wall. There is no learning loop that turns "Leon couldn't do X today" into "Leon can do X tomorrow."

The user wants Leon to be **self-extending**: when asked to do something it cannot, Leon should discover whether a Lark or internal API exists for it, propose a new tool, and — once admin approves — actually have that capability in its next reply.

## Non-goals

- **Full agentic code execution.** A "Tier 3" sandbox where Leon writes and runs arbitrary TypeScript is documented as a future direction in `## Tier 3 (RFC)` below, but is explicitly out of scope for this implementation.
- **A web admin UI for managing learned tools.** v1 is admin-via-Lark-card only. A `/admin/leon-tools` page can come later.
- **Cross-repo skill sharing.** Tools learned in this codebase stay in this codebase's DB.
- **Marketplace / discoverability of community tools.** Single-tenant only.
- **Replacing the existing `helper_learnings` system.** Learnings (atomic facts, rep prefs, self-critiques) are unchanged. Tools are a separate, complementary mechanism.

## Architecture: a three-tier capability ladder

Leon attempts the cheapest tier that solves the task, escalates only when the cheaper tier fails.

```
┌─────────────────────────────────────────────────────────────┐
│ Tier 1: Macros — chain existing tools                        │
│   "make_weekly_report" = get_admin_daily_report              │
│                          → get_org_helper_activity_today     │
│                          → create_rich_lark_doc(template)    │
│   No new capabilities. Just named recipes for known chains.  │
└─────────────────────────────────────────────────────────────┘
                            ↓ escalate when no macro fits
┌─────────────────────────────────────────────────────────────┐
│ Tier 2: Discovered tools — wrap new APIs                     │
│   Leon searches Lark OpenAPI / internal routes,              │
│   drafts a tool spec, admin approves via Lark card,          │
│   spec lands in `leon_tools` table, available next message.  │
└─────────────────────────────────────────────────────────────┘
                            ↓ escalate when no API exists
┌─────────────────────────────────────────────────────────────┐
│ Tier 3: Generated code (RFC — not built in this round)       │
│   Leon writes TypeScript, runs in sandbox, returns result.   │
│   Design only. Implementation deferred until tier 2 proves   │
│   the discover/approve/use loop works.                       │
└─────────────────────────────────────────────────────────────┘
```

Plus, sitting at the same layer as the existing tool catalog: **doc-edit tools** that close the immediate "can't revise docs" gap. These are conventional hand-coded tools, not part of the self-extending machinery, but they ship in this spec because they're the trigger for the whole conversation.

### Why this ordering

- **Macros first** because they're cheapest to evaluate (a JSON recipe, no new code path) and safest (every step is an existing tool that already passed review).
- **Tier 2 second** because new API wrappers need admin approval and are slower per-iteration, but each one is a permanent capability gain.
- **Tier 3 last (and not yet built)** because arbitrary code generation on Vercel serverless has unsolved sandbox/secret problems that we don't want to block tiers 1 and 2 on.

## Doc-edit tools (immediate)

Four new tools, conventional hand-coded TypeScript, added to `helper-read-tools.ts`. `read_lark_doc` is a true read-tool (auto-executes). The three write tools (`replace_block`, `delete_block`, `insert_block_after`) follow the same precedent as `create_rich_lark_doc` and `append_to_lark_doc` already do — exposed as "lookup-style" tools so Leon can fire them in-line during a Lark DM. The rep is right there in chat, sees the message land, can call it back if it's wrong. (See the existing comment in `helper-tools.ts:62-67` for the rationale.)

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `read_lark_doc` | `{ document_id }` | `{ ok, blocks: [{ block_id, kind, text, depth }] }` | Calls Lark `GET /docx/v1/documents/:id/blocks`. Returns flattened block list with IDs Leon can reference. |
| `replace_block` | `{ document_id, block_id, new_block: RichBlock }` | `{ ok }` | Calls Lark `PATCH /docx/v1/documents/:id/blocks/:block_id`. Same `RichBlock` schema as `create_rich_lark_doc`. |
| `delete_block` | `{ document_id, block_id }` | `{ ok }` | Calls Lark `DELETE`. |
| `insert_block_after` | `{ document_id, after_block_id, new_block: RichBlock }` | `{ ok, block_id }` | Calls Lark batch insert with a positional anchor. |

Prompt addition for these: "When a rep asks you to edit an existing doc, you must `read_lark_doc` first to see the current block tree. Never guess block IDs."

These four tools alone solve gap (1). They do not require any of the self-extending machinery.

## Tier 1: Macros

### Data model

New table `leon_macros`:

```sql
CREATE TABLE leon_macros (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,           -- e.g. "weekly_team_report"
  description  text NOT NULL,                  -- 1-line, used in `list_macros` triggering
  trigger_hint text NOT NULL,                  -- when LLM should consider this macro (matches against user msg)
  steps        jsonb NOT NULL,                 -- [{ tool: "get_admin_daily_report", args: {...} | "$LLM_FILL" }]
  scope_rep_id integer REFERENCES sales_reps(id), -- NULL = org-wide
  created_by   integer NOT NULL REFERENCES sales_reps(id),
  success_count integer NOT NULL DEFAULT 0,    -- bumped on each successful execution
  failure_count integer NOT NULL DEFAULT 0,
  enabled      boolean NOT NULL DEFAULT true,
  superseded_by uuid REFERENCES leon_macros(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

`steps[]` is an ordered list of tool invocations. An arg value of `"$LLM_FILL"` means "Leon decides this at runtime"; a literal value is passed through. Output of step N is bound to `$step_N.field` and can be referenced in step N+1's args.

### New tools

| Tool | Kind | Args | Notes |
|---|---|---|---|
| `list_macros` | read | `{ task_hint?: string }` | Returns `[{ name, description, success_count }]` filtered by trigger_hint match against `task_hint`. |
| `run_macro` | read | `{ name, fill: { stepN_argname: value } }` | Executes the macro step-by-step, threading outputs. Returns final step's result. Bumps `success_count` on success, `failure_count` on any step error. |
| `propose_macro` | action (admin/senior only) | `{ name, description, trigger_hint, steps }` | Creates a `leon_macros` row. Requires admin/senior role. |
| `revise_macro` | action (admin only) | `{ id, ...same as propose }` | Marks old as superseded, creates v2. |

### When Leon proposes a macro (the "earn the right" rule)

Per user feedback: macros should not be proactively offered until they actually work. Concrete heuristic:

> Leon may propose `propose_macro` **only when**: in the current session, Leon has just successfully executed a chain of ≥2 tools that produced an artifact (doc/email/base row) AND the rep has confirmed the outcome was good (positive signal: "perfect", "好", "nice", explicit thanks; or negative-absence: rep moved on without correction within 3 turns) AND the same chain shape has been executed by Leon for any rep ≥1 prior time.

Two-execution threshold prevents the registry from filling with one-off recipes that turn out to be wrong.

If Leon proposes prematurely (LLM error), admin can reject the proposal with no cost. The proposal is a chat suggestion, not a DB write — the DB write only happens on the `propose_macro` tool call, which requires admin/senior role.

## Tier 2: Discovered tools

This is the centerpiece.

### Data model

New table `leon_tools`:

```sql
CREATE TABLE leon_tools (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,            -- snake_case, e.g. "create_calendar_event"
  description     text NOT NULL,                   -- shown to LLM in tool catalog
  source          text NOT NULL CHECK (source IN ('lark_openapi', 'internal_route')),
  endpoint        text NOT NULL,                   -- "POST /open-apis/calendar/v4/calendars/:cal_id/events" or "POST /api/missions/allocate-leads"
  args_schema     jsonb NOT NULL,                  -- JSONSchema for args
  returns_schema  jsonb,                           -- JSONSchema for return shape (best-effort)
  auth_kind       text NOT NULL CHECK (auth_kind IN ('lark_app_token', 'lark_user_token', 'internal_session', 'none')),
  side_effect     text NOT NULL CHECK (side_effect IN ('read', 'write')),
  proposed_by     integer NOT NULL REFERENCES sales_reps(id),
  proposed_via_msg_id text,                        -- the lark_messages.id where Leon proposed it (for audit)
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'denied', 'revoked')),
  approved_by     integer REFERENCES sales_reps(id),
  approved_at     timestamptz,
  denied_reason   text,
  scope_min_role  text NOT NULL DEFAULT 'admin' CHECK (scope_min_role IN ('admin', 'senior', 'sales')),
  enabled         boolean NOT NULL DEFAULT true,   -- admin can disable post-approval without deleting
  call_count      integer NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  superseded_by   uuid REFERENCES leon_tools(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leon_tools_active_idx ON leon_tools(approval_status, enabled) WHERE approval_status = 'approved' AND enabled;
```

`scope_min_role` defaults to `'admin'` for write endpoints because the safer default is "only admin can use this until proven safe for wider rollout."

### Discovery sources

Two sources, both in scope for v1:

1. **Lark OpenAPI** (`source = 'lark_openapi'`) — Leon searches the documented Lark/Feishu OpenAPI catalog. The `lark-openapi-explorer` skill in the surrounding environment already indexes this; we'll need a server-side equivalent for runtime use. Implementation: a static JSON index of Lark endpoints (~200 entries) checked into the repo at `src/lib/lark-openapi-index.json`, refreshed periodically by a script. Leon's `search_lark_apis(query)` tool greps this index by name + description.

2. **Internal routes** (`source = 'internal_route'`) — Leon can wrap routes under `src/app/api/*`. There is no OpenAPI schema for these. Two options for inferring the schema:
   - **(a) Admin provides at proposal time.** When Leon proposes wrapping `/api/foo`, Leon must include args + returns shapes in the proposal, derived from the rep's described intent. Admin reviews and edits in the approval card before approving. This is the v1 choice — keeps Leon out of the filesystem at runtime.
   - **(b) Leon reads the route source.** Deferred. Requires giving the bot read access to its own repo, which is a separate security conversation.

### Discovery + proposal flow

```
Rep: "Leon, schedule a 30-min check-in with Yujie tomorrow at 3pm"
                       ↓
Leon: [no tool found for "create calendar event"]
      [calls search_lark_apis("create calendar event")]
      [finds: POST /open-apis/calendar/v4/calendars/:cal_id/events]
                       ↓
Leon to rep: "我目前没有创建日程的能力. 我向 Xingze 提议加这个工具
              (Lark calendar API, write 类). 等他批准我就能直接帮你建.
              暂时你可以在 Lark 里手动建. 我已经把请求记下了."
                       ↓
Leon calls propose_tool({
  name: "create_calendar_event",
  description: "Create a Lark calendar event",
  source: "lark_openapi",
  endpoint: "POST /open-apis/calendar/v4/calendars/:cal_id/events",
  args_schema: { ... },
  side_effect: "write",
  scope_min_role: "sales"
})
                       ↓
Lark card to admin (Xingze):
  ┌─────────────────────────────────────────┐
  │ Leon wants a new tool                    │
  │                                          │
  │ Name: create_calendar_event              │
  │ What: Create a Lark calendar event       │
  │ Endpoint: POST /open-apis/calendar/...   │
  │ Why: Yujie asked for this on 5/15        │
  │ Min role: sales                          │
  │ Sample call: { cal_id: "...", ... }      │
  │                                          │
  │ [Approve]  [Deny]  [Edit & Approve]      │
  └─────────────────────────────────────────┘
                       ↓
Admin taps Approve → leon_tools.approval_status = 'approved'
                       ↓
Next time anyone (with role >= sales) asks Leon to schedule something,
Leon's tool catalog includes create_calendar_event and it just works.
```

### New tools to expose this flow

| Tool | Kind | Args | Notes |
|---|---|---|---|
| `search_lark_apis` | read | `{ query: string, limit?: number }` | Greps the static Lark OpenAPI index. Returns `[{ endpoint, description, method }]`. |
| `propose_tool` | action (admin/senior only) | `{ name, description, source, endpoint, args_schema, side_effect, scope_min_role }` | Inserts row in `leon_tools` with `approval_status='pending'`. Sends Lark approval card to admin. |
| `list_pending_tools` | read (admin only) | `{}` | Returns pending proposals for admin DM convenience. |

The Lark card's button handlers route through the existing `processJitrCardAction` pattern (see `lark-agent.ts:419`) — extended to handle `tool_action: "approve" | "deny"` payloads.

### Calling a tool: dynamic dispatch

Today, every tool is a hand-coded `case` in `runReadTool` (helper-read-tools.ts). For self-extending tools we add a generic dispatcher at the end of the switch:

```ts
default: {
  // Try dynamic catalog
  const dyn = await loadEnabledTool(call.tool);
  if (!dyn) return { tool: call.tool, result: { error: `unknown tool: ${call.tool}` } };
  if (!repHasRole(session.role, dyn.scope_min_role)) {
    return { tool: call.tool, result: { error: `tool requires role ${dyn.scope_min_role}; you are ${session.role}` } };
  }
  return await callDynamicTool(session, dyn, call.args);
}
```

Where `callDynamicTool`:
- For `source = 'lark_openapi'`: builds a Lark API call using the bot's `lark_app_token`, validating args against `args_schema` first.
- For `source = 'internal_route'`: calls the internal route. Per the auth decision below, the call carries a forged session matching the **calling rep**, not the bot.

### Auth model: caller's permissions

Per the brainstorming decision, Leon acts as the rep, never as a service identity *for tool calls Leon learned itself* (Lark APIs that require the app token — like sending IM messages — are a separate matter; those still use the bot identity because that's how Lark designed them).

- **For `source = 'internal_route'`:** The dispatcher mints a short-lived JWT for `session.repId` with the rep's current role (re-read from DB, per the `requireSession()` pattern in `auth-helpers.ts`) and includes it as the `qiji_session` cookie on the internal HTTP call. Internal route's existing auth middleware then enforces the rep's permissions exactly as if the rep had clicked the button themselves.
- **For `source = 'lark_openapi'`:** The bot's `lark_app_token` is used (no per-user Lark token in scope). Per-tool `scope_min_role` enforcement happens in `callDynamicTool` *before* the Lark call. This is the leak point — if `scope_min_role` is set wrong on a write endpoint, a sales rep could trigger something they shouldn't via Leon. Mitigation: writes default to `scope_min_role = 'admin'`; admin must explicitly downgrade during approval. The approval card surfaces this prominently.

### Fallback path when Leon hits a permission wall

When `repHasRole` check fails, Leon does NOT silently refuse. The system prompt is updated:

> "If a wrapped tool refuses with `requires role X` and you're below that role, do NOT pretend you couldn't find the tool. Tell the rep: '这个 (tool 名) 需要 admin/senior 权限, 我帮你升级给 Xingze' and call `record_admin_request` with the rep's original ask."

Without this, low-trust reps will see Leon mysteriously fail to do things higher-trust reps can do, with no explanation.

## Tier 3 (RFC — design only, deferred)

Documented so we know what we're aiming at; **not implemented in this round**.

### What it would do

Leon writes a TypeScript snippet to handle a one-off task no existing tool covers (e.g., "Leon, take this CSV and group by domain, then post the top 5 to the chat"). The snippet runs in a sandbox, returns a result, Leon shows it to the rep.

### Why it's deferred

Three unsolved problems, any of which is enough to defer:

1. **Sandbox.** Vercel serverless functions share the runtime — `vm.runInNewContext` is not enough to isolate generated code from `process.env`. Service keys (Supabase, Lark app secret, Resend, JWT secret) would all be reachable. Real isolation requires either: (a) a separate Cloudflare Worker with zero secrets, called over HTTP from the main app, (b) Deno Deploy isolates, or (c) restricting tier 3 to a strict whitelist of safe operations (string manipulation, math, no I/O). None of these is a same-week build.

2. **Code review for generated code.** Even with a sandbox, an admin reviewing "Leon wrote a 40-line TypeScript function" via a Lark card is a much harder review than "Leon wants to call this Lark API." Spec-only means we skip the question of how that review actually works in practice.

3. **Debugging story.** When generated code fails, who debugs it — Leon by re-generating, or the admin by reading a stack trace? The recursive case (Leon debugs Leon's code) is genuinely novel territory.

### What we'll do in this round

- Reserve the table name `leon_code_snippets` so it doesn't collide later.
- Add a single TODO file at `docs/superpowers/specs/2026-XX-XX-leon-tier-3-code-execution-rfc.md` (placeholder) so the next iteration starts from a real document.
- The system prompt for v1 explicitly tells Leon: "You cannot write or run code on your own. If a task genuinely requires that, escalate to admin."

## Components and changes summary

### New tables (one migration, e.g. `070-leon-self-extending.sql`)
- `leon_macros`
- `leon_tools`

### New library files
- `src/lib/leon-tools-catalog.ts` — runtime loader that joins hand-coded tool catalog with `leon_tools` rows where `enabled=true` and `approval_status='approved'`. Caches per-process for 60s; invalidates on `propose_tool` / approval-card click.
- `src/lib/leon-macros.ts` — macro execution engine (step iteration, output binding, success/failure counter updates).
- `src/lib/leon-dynamic-dispatcher.ts` — `callDynamicTool` for both `lark_openapi` and `internal_route` sources, including the rep-forged-session minting for internal routes.
- `src/lib/lark-openapi-index.json` — static index of Lark API endpoints (initial seed: ~200 entries from the public docs).
- `scripts/refresh-lark-openapi-index.mjs` — periodically re-syncs the index from Lark docs.

### Modified library files
- `src/lib/helper-tools.ts` — register new tool names in `READ_TOOL_NAMES` / `ACTION_TOOL_NAMES`; expand `TOOLS_PROMPT` with descriptions for `read_lark_doc`, `replace_block`, `delete_block`, `insert_block_after`, `list_macros`, `run_macro`, `propose_macro`, `revise_macro`, `search_lark_apis`, `propose_tool`, `list_pending_tools`.
- `src/lib/helper-read-tools.ts` — implement new doc-edit cases; add the dynamic-dispatch `default:` branch.
- `src/lib/lark-agent.ts` — extend `processJitrCardAction` (or rename to a more generic card-action handler) to handle `tool_action: approve|deny|edit_and_approve`; add the "earn the right to propose macro" check before any `propose_macro` proposal Leon emits.
- `src/lib/lark.ts` — new helpers `readLarkDoc`, `replaceLarkBlock`, `deleteLarkBlock`, `insertLarkBlockAfter`.
- System prompt in `lark-agent.ts:SYSTEM_BASE` — append the new "you can grow" section explaining the discover/propose flow, the macro proposal rule, and the permission-wall fallback.

### Lark approval card UI
A new card template: "Leon wants a new tool" with Approve / Deny / Edit-and-Approve buttons. Edit-and-Approve opens a follow-up DM where admin can change `scope_min_role`, the description, or the args_schema before final approval.

## Data flow: end-to-end trace for "schedule a meeting"

1. Rep: "Leon 帮我约 Yujie 明天下午 3 点开 30 分钟会议"
2. `processInboundLarkMessage` → `runAgent` → LLM round 1
3. LLM: no `create_calendar_event` in catalog. Calls `search_lark_apis("create calendar event")` lookup.
4. Round 2: Lark openapi search returns `POST /open-apis/calendar/v4/calendars/:cal_id/events`. LLM emits a text reply ("我没这个能力, 已经向 Xingze 提议加") + a `propose_tool` action proposal in a `tool` JSON block.
5. `extractAnyProposal` picks up the proposal. `autoExecuteSafeProposal` checks: is `propose_tool` safe? It is, *for admin/senior callers*. Yujie is senior, so it executes. Inserts `leon_tools` row with `approval_status='pending'`. Sends Lark card to Xingze.
6. Rep gets the chat reply.
7. Xingze taps Approve in Lark. Card webhook lands on `processJitrCardAction` (renamed/extended). `tool_action='approve'` → `leon_tools.approval_status='approved'`, `approved_by=5`, `approved_at=now()`. Cache invalidated.
8. Yujie sends "ok 那现在帮我建吧" or any subsequent message that re-triggers the calendar intent.
9. New LLM round, fresh tool catalog includes `create_calendar_event`. LLM calls it directly. Dispatcher validates args against `args_schema`, calls Lark API with the bot's `lark_app_token` (this is a `lark_openapi` source), Lark returns event ID, Leon replies "建好了, 链接: ..."
10. `leon_tools.call_count` bumps to 1.

## Error handling and observability

- **Schema validation errors** (LLM passes wrong arg types) → return error to LLM in same round; let it retry with corrected args (within iteration budget).
- **Auth failures from Lark / internal routes** → bump `leon_tools.error_count`, return error text to LLM, log to console with `[leon-tools]` prefix.
- **Tool error_count exceeds threshold** (e.g., 5 errors in 10 calls) → automatically set `enabled=false` and DM admin: "tool X is failing more than 50% — disabled, please review." Prevents a buggy tool from poisoning every conversation.
- **Macro step failures** → halt execution, return partial results + error to LLM, bump `failure_count`. LLM decides whether to retry or fall back to direct tool calls.
- **Audit trail** — every dynamic tool call writes a row to a new `leon_tool_calls` table (tool_id, rep_id, args, result_status, duration_ms, created_at) so we can answer "what has Leon been doing?" without reading every Lark message.

## Testing

This system is hard to test conventionally because the "win condition" is "Leon learns something new." But we can test the components:

- **Unit tests** for `leon-tools-catalog.ts` (caching, invalidation, role gating).
- **Unit tests** for `leon-macros.ts` step execution and output binding.
- **Integration test:** a script `scripts/test-leon-self-extending.mjs` that:
  1. Inserts a fake `leon_tools` row directly (skipping the proposal flow).
  2. Sends a synthetic Lark message that should trigger the tool.
  3. Asserts the tool was called and the response is non-empty.
- **Smoke test:** end-to-end with a real Lark conversation in a test chat — admin proposes a tool, approves, calls it. Manual but documented in a runbook.
- **No tests for tier 3** — it's not built.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM hallucinates a tool that doesn't exist in the index, breaks `search_lark_apis` results | Index is the source of truth; results return only validated entries. LLM can't "find" what's not there. |
| Admin approves a write tool with `scope_min_role='sales'` by mistake → low-trust rep does damage | Approval card shows the scope prominently; defaults are conservative (writes default to admin). Audit log lets us reconstruct + revoke. |
| Wrapped internal route uses a different auth pattern than `qiji_session` JWT, dispatcher's session-mint fails | First v1 only supports routes that use the standard `requireSession()` pattern. Routes with bespoke auth get rejected at proposal time with a clear error. |
| Macro registry fills with bad recipes (Leon proposes too eagerly) | The "earn the right" rule (≥2 successful executions, positive rep signal) plus admin-only `propose_macro` action gates it. |
| Tool catalog grows large enough to bloat every prompt | Loaded tools are surfaced to LLM as `name + 1-line description` only. Full schema fetched only when LLM calls the tool. ~200 tools at 80 chars each = 16k tokens, within budget. Beyond that we add the same `task_hint`-based filtering used for macros. |
| Lark API endpoints change, wrapped tools break silently | `error_count` auto-disable is the safety net. Periodic re-validation script (`scripts/validate-leon-tools.mjs`) probes each tool with a no-op call and reports drift. |

## Open questions (resolve in implementation plan)

1. **Where does the static Lark OpenAPI index come from initially?** Manual seed from the public docs vs. scrape. Probably manual seed of the ~30 most-likely endpoints (calendar, drive, base CRUD, sheets, im) for v1, then expand based on what Leon actually searches for.
2. **Do we let admin batch-approve multiple proposals?** Probably no for v1 — one card per tool, one tap per approval.
3. **Should `revoke` (post-approval disable) also have a Lark card flow, or just admin web UI?** Lean toward Lark for parity, but it's not in v1 scope — admin can flip `enabled=false` via SQL or a one-off script if a tool goes bad before the admin UI exists.

## Build sequence (high level)

This is the rough order — the implementation plan (next deliverable) will break it into reviewable chunks.

1. **Doc-edit tools** (4 new hand-coded tools, no schema changes). Ships Leon's ability to revise docs *today*. Lowest risk, immediate value.
2. **Migration 070 + tool catalog runtime loader.** Creates the tables, makes the dispatcher generic, no behavior change yet.
3. **Tier 2 read-side: `search_lark_apis`, `propose_tool`, `list_pending_tools`, the Lark approval card.** Leon can now propose new tools; admin can approve them.
4. **Tier 2 call-side: dynamic dispatcher with caller-permissions auth.** Approved tools become callable.
5. **Tier 1: macro tables + execution engine + the four macro tools + the "earn the right" rule.** Now Leon can also chain known tools.
6. **System prompt rewrite** to teach Leon about its new abilities, the proposal flow, the permission-wall fallback, and the macro-proposal restraint rule.
7. **Tier 3 RFC document** (separate file, no code).

Each step ships independently and is useful on its own.
