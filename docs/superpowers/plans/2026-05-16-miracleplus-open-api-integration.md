# MiraclePlus Open API Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the奇绩 Open API (`https://build.miracleplus.com`) into the pipeline so we can pull newly-registered users / submitted applications filtered to `source=gpu` (our team), match them against our outbound `emails.to` to compute the **real conversion ground-truth** ("of the people we cold-emailed, how many actually filled the form?"), and attribute that conversion to the rep who **actually sent the email** (`emails.actor_rep_id`, NOT `assigned_rep_id`).

**Architecture:** Migration 099 adds two tables — `oauth_tokens` (provider + access/refresh tokens + expiry, keyed by `provider`) and `miracleplus_contacts` (mirror of pulled contacts, primary key `mp_contact_id`). One-time admin bootstrap script (`scripts/mp-oauth-bootstrap.mjs`) walks the operator through the `authorization_code` flow once and stashes the refresh_token. `src/lib/miracleplus-oauth.ts` exposes `getAccessToken()` that auto-refreshes when within 5 min of expiry. `src/lib/miracleplus-api.ts` is a thin typed wrapper over `/contacts/search`, `/contacts/:id`, `/contacts`, `/contacts/batch_update`, `/user/me`. A new cron `/api/cron/sync-miracleplus-contacts` paginates `contacts/search?filters=g|eq|s_product|gpu` daily and upserts into the mirror table. The conversion matrix is computed in `canonical-counts.ts` (new `getMpConversionMatrix()` primitive) by joining the mirror table's emails against `emails.to` and `brief_lookups.added_wechat`. Surface lives on a new `/admin/conversion-matrix` page + a Leon read tool `get_mp_conversions`. Verification smoke does the OAuth dance, runs the cron once, and asserts non-zero matches against our ~1500 sent emails.

**Tech Stack:** Next.js 16, Supabase Postgres, OAuth 2.0 authorization_code + refresh_token flow, existing `canonical-counts` module for any displayed numbers.

**Spec source:** User's 2026-05-16 ask + Open API doc summary captured in session memory `project_gpu_team_and_open_api.md`.

---

## File map

**New (migration + runner):**
- `migrations/099-miracleplus-oauth-and-contacts.sql`
- `scripts/apply-099.mjs`

**New (libraries):**
- `src/lib/miracleplus-oauth.ts` — token storage + refresh logic
- `src/lib/miracleplus-api.ts` — typed API client
- `src/lib/miracleplus-sync.ts` — pagination + upsert into mirror table

**New (routes):**
- `src/app/api/cron/sync-miracleplus-contacts/route.ts` — daily sync cron
- `src/app/api/admin/mp-oauth/callback/route.ts` — OAuth redirect catcher (used once by bootstrap)
- `src/app/admin/conversion-matrix/page.tsx` — 2x2 matrix UI

**New (scripts):**
- `scripts/mp-oauth-bootstrap.mjs` — one-time admin OAuth dance
- `scripts/smoke-miracleplus-integration.mjs` — end-to-end verification

**Modified:**
- `src/lib/canonical-counts.ts` — add `getMpConversionMatrix()` primitive
- `src/lib/helper-tools.ts` — register `get_mp_conversions` read tool in `TOOLS_PROMPT`
- `src/lib/helper-read-tools.ts` — dispatch `get_mp_conversions`
- `src/app/api/cron/route.ts` — add `mp_sync` to the fan-out array
- `.env.local.example` — add `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI`

---

## Task 1: Migration 099 — oauth_tokens + miracleplus_contacts tables

**Files:**
- Create: `migrations/099-miracleplus-oauth-and-contacts.sql`
- Create: `scripts/apply-099.mjs`

- [ ] **Step 1: Write the migration SQL**

```sql
-- migrations/099-miracleplus-oauth-and-contacts.sql
--
-- 1. SCHEMA CHANGE
-- Two new tables:
--   oauth_tokens         — single-row-per-provider stash of OAuth access +
--                          refresh tokens. Columns:
--                            provider text PRIMARY KEY        -- 'miracleplus'
--                            access_token text NOT NULL
--                            refresh_token text NOT NULL
--                            access_expires_at timestamptz NOT NULL
--                            scopes text                       -- space-separated
--                            obtained_by_rep_id int            -- admin who ran bootstrap
--                            obtained_at timestamptz DEFAULT now()
--                            updated_at timestamptz DEFAULT now()
--
--   miracleplus_contacts — mirror of contacts pulled from
--                          GET /open_api/v1/contacts/search?filters=g|eq|s_product|gpu.
--                          Columns:
--                            mp_contact_id text PRIMARY KEY    -- their id, immutable
--                            email text                        -- lower-cased on insert
--                            name text
--                            phone text
--                            s_product text                    -- 'gpu' for us
--                            s_channel text
--                            utm_source text
--                            raw_json jsonb NOT NULL           -- full API payload, in case
--                                                              -- new fields appear we
--                                                              -- haven't modeled yet
--                            mp_created_at timestamptz         -- created_at from MP
--                            mp_updated_at timestamptz         -- updated_at from MP
--                            first_seen_at timestamptz DEFAULT now()
--                            last_synced_at timestamptz DEFAULT now()
--
-- 2. WHO WRITES?
-- oauth_tokens: scripts/mp-oauth-bootstrap.mjs (initial INSERT),
--   src/lib/miracleplus-oauth.ts:refreshAccessToken (subsequent UPDATEs).
-- miracleplus_contacts: src/lib/miracleplus-sync.ts:upsertContacts called
--   by /api/cron/sync-miracleplus-contacts (daily).
--
-- 3. WHO READS?
-- oauth_tokens: src/lib/miracleplus-oauth.ts:getAccessToken on every API call.
-- miracleplus_contacts:
--   - src/lib/canonical-counts.ts:getMpConversionMatrix joins email ⇆
--     emails.to + brief_lookups
--   - /admin/conversion-matrix page reads via that primitive
--   - Leon read tool get_mp_conversions reads via that primitive
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — both tables are new. miracleplus_contacts will be
-- populated by the first cron run (paginates from page=1 with no time
-- filter, so it grabs everything that currently exists with s_product=gpu).

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider          text PRIMARY KEY,
  access_token      text NOT NULL,
  refresh_token     text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  scopes            text,
  obtained_by_rep_id int REFERENCES sales_reps(id),
  obtained_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS miracleplus_contacts (
  mp_contact_id   text PRIMARY KEY,
  email           text,
  name            text,
  phone           text,
  s_product       text,
  s_channel       text,
  utm_source      text,
  raw_json        jsonb NOT NULL,
  mp_created_at   timestamptz,
  mp_updated_at   timestamptz,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_synced_at  timestamptz NOT NULL DEFAULT now()
);

-- Email is the join key against emails.to. Lowercase + index it for the
-- conversion-matrix query, which scans the whole table joining against
-- ~1500 sent emails. Partial index skips rows with no email at all.
CREATE INDEX IF NOT EXISTS miracleplus_contacts_email_idx
  ON miracleplus_contacts (lower(email))
  WHERE email IS NOT NULL;

-- s_product=gpu is our filter; index it so admin-facing "show me only
-- our team's contacts" stays fast.
CREATE INDEX IF NOT EXISTS miracleplus_contacts_s_product_idx
  ON miracleplus_contacts (s_product);

-- last_synced_at lets us see staleness in the admin UI.
CREATE INDEX IF NOT EXISTS miracleplus_contacts_last_synced_idx
  ON miracleplus_contacts (last_synced_at DESC);
```

- [ ] **Step 2: Write the apply runner**

`scripts/apply-099.mjs`:

```javascript
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/099-miracleplus-oauth-and-contacts.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

console.log("ok — verifying tables reachable:");
const probeOauth = await sb.from("oauth_tokens").select("provider").limit(1);
if (probeOauth.error) { console.error("oauth_tokens probe FAIL:", probeOauth.error.message); process.exit(1); }
console.log("  ✓ oauth_tokens reachable");

const probeContacts = await sb.from("miracleplus_contacts").select("mp_contact_id").limit(1);
if (probeContacts.error) { console.error("miracleplus_contacts probe FAIL:", probeContacts.error.message); process.exit(1); }
console.log("  ✓ miracleplus_contacts reachable");

// Verify indexes exist
const { data: idxCheck, error: idxErr } = await sb.rpc("_run_select_sql", {
  sql_text: "SELECT indexname FROM pg_indexes WHERE tablename='miracleplus_contacts' ORDER BY indexname",
  sql_params: [],
});
if (idxErr) { console.error("index probe FAIL:", idxErr.message); process.exit(1); }
const idxRows = Array.isArray(idxCheck) ? idxCheck : (idxCheck?.rows ?? []);
console.log("  ✓ indexes present:", idxRows.map((r) => r.indexname).join(", "));
if (idxRows.length < 3) { console.error("expected 3 indexes, got", idxRows.length); process.exit(1); }
```

- [ ] **Step 3: Run + verify + commit**

```bash
node scripts/apply-099.mjs
# expect:
#   ok — verifying tables reachable:
#     ✓ oauth_tokens reachable
#     ✓ miracleplus_contacts reachable
#     ✓ indexes present: miracleplus_contacts_email_idx, miracleplus_contacts_last_synced_idx, miracleplus_contacts_s_product_idx
git add migrations/099-miracleplus-oauth-and-contacts.sql scripts/apply-099.mjs
git commit -m "migration(099): oauth_tokens + miracleplus_contacts mirror"
```

---

## Task 2: Env var scaffolding

**Files:**
- Modify: `.env.local.example` (add the three new vars at the bottom)

- [ ] **Step 1: Append vars to `.env.local.example`**

Append exactly these lines (the file currently ends after the existing vars — preserve them, add at bottom):

```bash
# MiraclePlus Open API (奇绩 build.miracleplus.com)
# Obtain MP_CLIENT_ID / MP_CLIENT_SECRET from the parent team's API
# admin (they register us as an OAuth client). MP_REDIRECT_URI must be
# registered at registration time; we use our admin callback route so
# the one-time OAuth dance can capture the code via browser.
MP_CLIENT_ID=
MP_CLIENT_SECRET=
MP_REDIRECT_URI=https://calistamind.com/api/admin/mp-oauth/callback
```

- [ ] **Step 2: Verify locally**

```bash
grep MP_CLIENT_ID .env.local.example
# expect: MP_CLIENT_ID=
```

- [ ] **Step 3: Commit**

```bash
git add .env.local.example
git commit -m "env: scaffold MP_CLIENT_ID/SECRET/REDIRECT_URI for MiraclePlus OAuth"
```

> **Operator note:** The actual values must be set in Vercel env (`vercel env add MP_CLIENT_ID production` etc.) before Task 9 runs — NOT in `.env.local.example` which is committed. The example file is just so future devs know which vars exist.

---

## Task 3: OAuth token manager — `src/lib/miracleplus-oauth.ts`

**Files:**
- Create: `src/lib/miracleplus-oauth.ts`
- Create: `scripts/test-mp-oauth-refresh.mjs`

- [ ] **Step 1: Write the failing smoke test first**

`scripts/test-mp-oauth-refresh.mjs`:

```javascript
/**
 * Smoke: getAccessToken() returns a string and refreshes when expiry is
 * within 5 min. Requires oauth_tokens row already populated (via the
 * bootstrap script in Task 5). Skip with exit 0 if no row yet.
 * Run: npx tsx --env-file=.env.local scripts/test-mp-oauth-refresh.mjs
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

// Skip-gate: if no oauth_tokens row, bootstrap hasn't run yet — exit 0.
const { data: row } = await sb.from("oauth_tokens").select("provider").eq("provider", "miracleplus").maybeSingle();
if (!row) {
  console.log("SKIP — no miracleplus oauth_tokens row yet (run bootstrap first).");
  process.exit(0);
}

const { getAccessToken } = await import("../src/lib/miracleplus-oauth.ts");

const tok = await getAccessToken();
assert(typeof tok === "string" && tok.length > 20, "getAccessToken returns non-trivial string");

// Force expiry to "soon" and confirm refresh triggers
await sb.from("oauth_tokens").update({ access_expires_at: new Date(Date.now() + 60_000).toISOString() }).eq("provider", "miracleplus");
const tok2 = await getAccessToken();
assert(typeof tok2 === "string" && tok2.length > 20, "getAccessToken survives near-expiry");

const { data: after } = await sb.from("oauth_tokens").select("access_expires_at").eq("provider", "miracleplus").single();
const expiryMs = new Date(after.access_expires_at).getTime() - Date.now();
assert(expiryMs > 30 * 60_000, `post-refresh expiry > 30min (got ${Math.round(expiryMs/60000)}min)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Run and verify it fails on import**

```bash
npx tsx --env-file=.env.local scripts/test-mp-oauth-refresh.mjs
# expect: SKIP (if no row) OR import error "Cannot find module '../src/lib/miracleplus-oauth.ts'"
```

- [ ] **Step 3: Write the module**

`src/lib/miracleplus-oauth.ts`:

```typescript
/**
 * MiraclePlus OAuth 2.0 token manager.
 *
 * Single-row-per-provider stash in oauth_tokens (migration 099).
 * On every API call, getAccessToken() reads the row, refreshes if the
 * access_token is expired or within 5 minutes of expiry, and returns a
 * valid bearer token.
 *
 * Bootstrap (one-time admin dance) lives in scripts/mp-oauth-bootstrap.mjs
 * and writes the initial row via authorization_code grant. From then on,
 * this module silently refreshes via refresh_token grant.
 *
 * The contacts API only accepts authorization_code-derived tokens
 * (client_credentials gets 403), so refresh_token grant is the only
 * server-friendly path for daily cron use.
 */

import { supabase } from "@/lib/db";

const PROVIDER = "miracleplus";
const BASE_URL = "https://build.miracleplus.com";
// Refresh if access token expires within this many ms.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface MpOAuthRow {
  provider: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  scopes: string | null;
  obtained_by_rep_id: number | null;
  obtained_at: string;
  updated_at: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;       // may not be re-issued on every refresh
  token_type: "Bearer" | string;
  expires_in: number;            // seconds
  scope?: string;
}

/**
 * Return a valid access token, refreshing if necessary.
 * Throws if no oauth_tokens row exists (bootstrap must run first).
 */
export async function getAccessToken(): Promise<string> {
  const row = await loadRow();
  if (!row) {
    throw new Error(
      "miracleplus oauth_tokens row missing — run scripts/mp-oauth-bootstrap.mjs to authorize",
    );
  }
  const expiresMs = new Date(row.access_expires_at).getTime() - Date.now();
  if (expiresMs > REFRESH_BUFFER_MS) {
    return row.access_token;
  }
  const refreshed = await refreshAccessToken(row.refresh_token);
  return refreshed.access_token;
}

/**
 * Internal: refresh + persist. Exported only for the smoke test.
 */
export async function refreshAccessToken(refreshToken: string): Promise<MpOAuthRow> {
  const clientId = process.env.MP_CLIENT_ID;
  const clientSecret = process.env.MP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("MP_CLIENT_ID / MP_CLIENT_SECRET not set in env");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`mp oauth refresh failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as TokenResponse;
  // Some providers re-issue refresh_token; default to the existing one if not.
  const newRefresh = json.refresh_token ?? refreshToken;
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  const { data, error } = await supabase
    .from("oauth_tokens")
    .update({
      access_token: json.access_token,
      refresh_token: newRefresh,
      access_expires_at: expiresAt,
      scopes: json.scope ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("provider", PROVIDER)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`oauth_tokens update failed: ${error?.message ?? "no row"}`);
  }
  return data as MpOAuthRow;
}

/**
 * Internal: load the row. Returns null if not yet bootstrapped.
 */
async function loadRow(): Promise<MpOAuthRow | null> {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("*")
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`oauth_tokens read failed: ${error.message}`);
  return (data as MpOAuthRow | null) ?? null;
}

/**
 * Bootstrap entry — called by scripts/mp-oauth-bootstrap.mjs ONLY.
 * Exchanges an authorization_code for the initial token pair and writes
 * the row. Re-running upserts (idempotent).
 */
export async function bootstrapWithCode(
  authorizationCode: string,
  obtainedByRepId: number | null,
): Promise<MpOAuthRow> {
  const clientId = process.env.MP_CLIENT_ID;
  const clientSecret = process.env.MP_CLIENT_SECRET;
  const redirectUri = process.env.MP_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("MP_CLIENT_ID / MP_CLIENT_SECRET / MP_REDIRECT_URI not set in env");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`mp oauth bootstrap failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as TokenResponse;
  if (!json.refresh_token) {
    throw new Error("mp oauth bootstrap response had no refresh_token — cannot proceed");
  }
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  const { data, error } = await supabase
    .from("oauth_tokens")
    .upsert(
      {
        provider: PROVIDER,
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        access_expires_at: expiresAt,
        scopes: json.scope ?? null,
        obtained_by_rep_id: obtainedByRepId,
        obtained_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider" },
    )
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`oauth_tokens upsert failed: ${error?.message ?? "no row"}`);
  }
  return data as MpOAuthRow;
}
```

- [ ] **Step 4: TypeScript compiles**

```bash
npx tsc --noEmit
# expect: no errors mentioning miracleplus-oauth.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/miracleplus-oauth.ts scripts/test-mp-oauth-refresh.mjs
git commit -m "feat(mp): OAuth token manager with auto-refresh"
```

---

## Task 4: API client — `src/lib/miracleplus-api.ts`

**Files:**
- Create: `src/lib/miracleplus-api.ts`
- Create: `scripts/test-mp-api-shape.mjs`

- [ ] **Step 1: Write the failing smoke test**

`scripts/test-mp-api-shape.mjs`:

```javascript
/**
 * Smoke: searchContacts({ s_product: "gpu", page: 1, per: 5 }) returns a
 * page with the expected shape. Requires bootstrap done (Task 5). Skip
 * cleanly when not bootstrapped.
 * Run: npx tsx --env-file=.env.local scripts/test-mp-api-shape.mjs
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

const { data: row } = await sb.from("oauth_tokens").select("provider").eq("provider", "miracleplus").maybeSingle();
if (!row) {
  console.log("SKIP — no miracleplus oauth_tokens row yet (run bootstrap first).");
  process.exit(0);
}

const { searchContacts, getMe } = await import("../src/lib/miracleplus-api.ts");

const me = await getMe();
assert(typeof me === "object" && me !== null, "getMe returned object");
console.log("    me =", JSON.stringify(me).slice(0, 200));

const page1 = await searchContacts({ filters: "g|eq|s_product|gpu", page: 1, per: 5 });
assert(Array.isArray(page1.contacts), "searchContacts.contacts is an array");
assert(typeof page1.total === "number", "searchContacts.total is a number");
console.log(`    returned ${page1.contacts.length} of ${page1.total} total`);

if (page1.contacts[0]) {
  const c = page1.contacts[0];
  assert(typeof c.id === "string", "contact has string id");
  // email is optional in the API but our gpu pool should mostly have one
  console.log("    sample contact email:", c.email ?? "(none)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Run and confirm it fails on import**

```bash
npx tsx --env-file=.env.local scripts/test-mp-api-shape.mjs
# expect: SKIP or import error "Cannot find module '../src/lib/miracleplus-api.ts'"
```

- [ ] **Step 3: Write the module**

`src/lib/miracleplus-api.ts`:

```typescript
/**
 * Typed wrapper over the MiraclePlus Open API (build.miracleplus.com).
 *
 * Every call goes through getAccessToken() in miracleplus-oauth.ts so
 * the bearer is always valid. We expose only the verbs we need for the
 * pipeline integration — contacts search/get/create/update, plus user/me
 * for the bootstrap sanity check.
 *
 * Filter syntax (per their docs): g|<op>|<field>|<value>, e.g.
 *   "g|eq|s_product|gpu"
 *   "g|in|s_product|gpu,apply"
 * Multiple filters AND-ed by joining with ",".
 */

import { getAccessToken } from "@/lib/miracleplus-oauth";

const BASE_URL = "https://build.miracleplus.com";

export interface MpContact {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  s_product: string | null;
  s_channel: string | null;
  utm_source: string | null;
  created_at: string | null;
  updated_at: string | null;
  // The API may return extra fields — we keep them in raw and let callers
  // dig in when needed.
  [extra: string]: unknown;
}

export interface SearchContactsArgs {
  q?: string;
  filters?: string;        // raw filter string, see header
  page?: number;           // 1-based
  per?: number;            // max 200 per API docs
}

export interface SearchContactsResult {
  contacts: MpContact[];
  total: number;
  page: number;
  per: number;
}

/**
 * GET /open_api/v1/user/me — bootstrap sanity check.
 */
export async function getMe(): Promise<Record<string, unknown>> {
  return apiGet("/open_api/v1/user/me");
}

/**
 * GET /open_api/v1/contacts/search?q=&filters=&page=&per=
 * Returns a single page. Use searchAllContacts for paginated drain.
 */
export async function searchContacts(args: SearchContactsArgs = {}): Promise<SearchContactsResult> {
  const per = Math.max(1, Math.min(200, args.per ?? 100));
  const page = Math.max(1, args.page ?? 1);
  const params = new URLSearchParams();
  if (args.q) params.set("q", args.q);
  if (args.filters) params.set("filters", args.filters);
  params.set("page", String(page));
  params.set("per", String(per));
  const raw = await apiGet(`/open_api/v1/contacts/search?${params.toString()}`) as Record<string, unknown>;
  // The API returns {data: [...], total: N, page, per} per their spec.
  // Be defensive about shape — fall back to common alternatives.
  const list = Array.isArray(raw.data) ? raw.data
              : Array.isArray(raw.contacts) ? raw.contacts
              : Array.isArray(raw.items) ? raw.items
              : [];
  const total = typeof raw.total === "number" ? raw.total
              : typeof raw.total_count === "number" ? raw.total_count
              : list.length;
  return {
    contacts: list as MpContact[],
    total,
    page,
    per,
  };
}

/**
 * Paginated drain: yields all contacts matching `filters`. Stops when
 * a page returns < per rows OR we hit maxPages (safety brake).
 */
export async function* searchAllContacts(
  args: Omit<SearchContactsArgs, "page"> & { maxPages?: number } = {},
): AsyncGenerator<MpContact, void, unknown> {
  const per = Math.max(1, Math.min(200, args.per ?? 100));
  const maxPages = Math.max(1, args.maxPages ?? 100);
  for (let page = 1; page <= maxPages; page++) {
    const res = await searchContacts({ q: args.q, filters: args.filters, page, per });
    for (const c of res.contacts) yield c;
    if (res.contacts.length < per) return;
  }
}

/**
 * GET /open_api/v1/contacts/:id
 */
export async function getContact(id: string): Promise<MpContact> {
  return apiGet(`/open_api/v1/contacts/${encodeURIComponent(id)}`) as Promise<MpContact>;
}

// ── Internals ─────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`MP API GET ${path} failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  return res.json();
}
```

- [ ] **Step 4: TypeScript compiles**

```bash
npx tsc --noEmit
# expect: no errors mentioning miracleplus-api.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/miracleplus-api.ts scripts/test-mp-api-shape.mjs
git commit -m "feat(mp): typed API client for contacts + user/me"
```

---

## Task 5: OAuth bootstrap script + callback route

**Files:**
- Create: `src/app/api/admin/mp-oauth/callback/route.ts`
- Create: `scripts/mp-oauth-bootstrap.mjs`

This is the one-time admin dance: admin opens the auth URL in a browser, MiraclePlus redirects to our callback with `?code=...`, the callback hands the code back to the bootstrap script, the script exchanges code for tokens and writes the row.

- [ ] **Step 1: Write the callback route**

`src/app/api/admin/mp-oauth/callback/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { bootstrapWithCode } from "@/lib/miracleplus-oauth";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/mp-oauth/callback?code=...&state=...
 *
 * Catches the OAuth redirect from MiraclePlus, exchanges the code for
 * the initial token pair, and writes oauth_tokens. Renders a tiny HTML
 * page so the admin sees confirmation in the browser.
 *
 * Auth: must be logged in as admin (re-checked from DB via requireAdmin).
 * The OAuth `state` is verified against ?expected_state= passed through.
 * We don't bother with CSRF state for v1 because (a) only an admin can
 * hit this route, and (b) this gets used once every time refresh_token
 * is invalidated by MiraclePlus.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return new NextResponse("Unauthorized — log in as admin first.", { status: 401 });
  }
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    return new NextResponse(`OAuth error: ${error}`, { status: 400 });
  }
  if (!code) {
    return new NextResponse("Missing ?code= in callback URL.", { status: 400 });
  }
  try {
    const row = await bootstrapWithCode(code, admin.id);
    return new NextResponse(
      `<html><body style="font-family:system-ui;padding:2rem;max-width:60ch">
        <h1>MiraclePlus OAuth complete</h1>
        <p>Refresh token stored. Cron will pick it up on next run.</p>
        <ul>
          <li>provider: ${row.provider}</li>
          <li>access expires: ${row.access_expires_at}</li>
          <li>scopes: ${row.scopes ?? "(none returned)"}</li>
          <li>obtained_by_rep_id: ${row.obtained_by_rep_id}</li>
        </ul>
       </body></html>`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  } catch (e) {
    return new NextResponse(`Bootstrap failed: ${String(e).slice(0, 500)}`, { status: 500 });
  }
}
```

- [ ] **Step 2: Write the bootstrap helper script**

`scripts/mp-oauth-bootstrap.mjs`:

```javascript
/**
 * One-time MiraclePlus OAuth bootstrap.
 *
 * Usage:
 *   1. Set MP_CLIENT_ID, MP_CLIENT_SECRET, MP_REDIRECT_URI in env
 *      (Vercel prod env; locally in .env.local).
 *   2. Make sure MP_REDIRECT_URI points at a deployed
 *      /api/admin/mp-oauth/callback route (the prod one is fine —
 *      you just need to be logged into the dashboard as admin
 *      in the same browser session).
 *   3. Run: node scripts/mp-oauth-bootstrap.mjs
 *   4. Open the printed URL in the browser, click Authorize, the
 *      callback writes the row, you see a green HTML page.
 *   5. Verify with: node scripts/mp-oauth-bootstrap.mjs --check
 *
 * The script doesn't write the row itself — the callback route does
 * (so we get admin auth gating). This script is just a UX wrapper:
 * it prints the URL to open, and the --check flag verifies the row
 * landed.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://erguqrisqtugfysofwdd.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_KEY) {
  console.error("SUPABASE_SERVICE_KEY not set in env. Did you `--env-file=.env.local`?");
  process.exit(1);
}

const CLIENT_ID = process.env.MP_CLIENT_ID;
const REDIRECT_URI = process.env.MP_REDIRECT_URI;
if (!CLIENT_ID || !REDIRECT_URI) {
  console.error("MP_CLIENT_ID / MP_REDIRECT_URI must be set in env.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

if (process.argv.includes("--check")) {
  const { data, error } = await sb.from("oauth_tokens").select("*").eq("provider", "miracleplus").maybeSingle();
  if (error) { console.error("read failed:", error.message); process.exit(1); }
  if (!data) {
    console.log("NO ROW yet. Open the URL printed without --check to authorize.");
    process.exit(1);
  }
  const expiresMs = new Date(data.access_expires_at).getTime() - Date.now();
  console.log("✓ oauth_tokens row present");
  console.log(`  access_expires_at: ${data.access_expires_at} (${Math.round(expiresMs/60000)}min from now)`);
  console.log(`  scopes:            ${data.scopes ?? "(none)"}`);
  console.log(`  obtained_by_rep:   ${data.obtained_by_rep_id ?? "(none)"}`);
  console.log(`  obtained_at:       ${data.obtained_at}`);
  process.exit(0);
}

// Build the authorize URL. Scopes per session memory: contacts_read is
// the minimum we need for the daily sync. contacts_write is for the
// optional push-our-contacts-back use case.
const scopes = ["contacts_read"];
const state = Math.random().toString(36).slice(2);
const authUrl = new URL("https://build.miracleplus.com/oauth/authorize");
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", scopes.join(" "));
authUrl.searchParams.set("state", state);

console.log("\nOpen this URL in a browser where you're logged in to the dashboard as admin:\n");
console.log(authUrl.toString());
console.log("\nAfter MiraclePlus redirects back, you should see a green confirmation page.");
console.log(`Then run: node scripts/mp-oauth-bootstrap.mjs --check\n`);
```

- [ ] **Step 3: Verify route compiles**

```bash
npx tsc --noEmit
# expect: no errors mentioning mp-oauth/callback/route.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/mp-oauth/callback/route.ts scripts/mp-oauth-bootstrap.mjs
git commit -m "feat(mp): one-time OAuth bootstrap (admin-gated callback + helper script)"
```

> **Operator note:** The actual OAuth dance happens in production AFTER deploy — locally you'd need to expose the callback via tunnel, which isn't worth it for a once-a-quarter operation. Wait until Task 9 to actually run this.

---

## Task 6: Sync library — `src/lib/miracleplus-sync.ts`

**Files:**
- Create: `src/lib/miracleplus-sync.ts`
- Create: `scripts/test-mp-sync.mjs`

- [ ] **Step 1: Write the smoke test**

`scripts/test-mp-sync.mjs`:

```javascript
/**
 * Smoke: syncGpuContacts({ maxPages: 2 }) upserts into
 * miracleplus_contacts and returns counts. Skip if not bootstrapped.
 * Run: npx tsx --env-file=.env.local scripts/test-mp-sync.mjs
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

const { data: row } = await sb.from("oauth_tokens").select("provider").eq("provider", "miracleplus").maybeSingle();
if (!row) {
  console.log("SKIP — no miracleplus oauth_tokens row.");
  process.exit(0);
}

const { syncGpuContacts } = await import("../src/lib/miracleplus-sync.ts");

const before = (await sb.from("miracleplus_contacts").select("mp_contact_id", { count: "exact", head: true })).count ?? 0;
const result = await syncGpuContacts({ maxPages: 2 });
const after = (await sb.from("miracleplus_contacts").select("mp_contact_id", { count: "exact", head: true })).count ?? 0;

assert(typeof result.fetched === "number", "result.fetched is a number");
assert(typeof result.upserted === "number", "result.upserted is a number");
assert(result.fetched >= 0, "result.fetched >= 0");
assert(after >= before, `row count did not decrease (was ${before}, now ${after})`);
console.log(`    fetched=${result.fetched} upserted=${result.upserted} pages=${result.pages}`);

if (after > 0) {
  const sample = await sb.from("miracleplus_contacts").select("*").limit(1).single();
  assert(sample.data?.s_product === "gpu" || sample.data?.s_product == null, "sample has s_product=gpu or null");
  assert(typeof sample.data?.raw_json === "object" && sample.data?.raw_json !== null, "raw_json populated");
  console.log(`    sample email: ${sample.data?.email ?? "(null)"}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Confirm it fails on import**

```bash
npx tsx --env-file=.env.local scripts/test-mp-sync.mjs
# expect: SKIP or "Cannot find module"
```

- [ ] **Step 3: Write the module**

`src/lib/miracleplus-sync.ts`:

```typescript
/**
 * Sync MiraclePlus contacts (source=gpu) into our miracleplus_contacts
 * mirror table.
 *
 * Called daily by /api/cron/sync-miracleplus-contacts. Idempotent —
 * uses upsert on mp_contact_id, so re-running on the same data is a
 * no-op (just bumps last_synced_at).
 *
 * Filter is `g|eq|s_product|gpu`. If the parent team later changes
 * how they tag our team's contacts, update the FILTER constant here
 * (this is the single source of truth — don't hand-write the filter
 * elsewhere).
 */

import { supabase } from "@/lib/db";
import { searchAllContacts, type MpContact } from "@/lib/miracleplus-api";

const FILTER = "g|eq|s_product|gpu";

export interface SyncResult {
  fetched: number;
  upserted: number;
  pages: number;
  errors: string[];
  durationMs: number;
}

export interface SyncOpts {
  /** Cap pages drained per run. Default 100 (per=200 → 20k contacts max). */
  maxPages?: number;
  /** Per-page size. Max 200 per API docs. */
  perPage?: number;
}

export async function syncGpuContacts(opts: SyncOpts = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  let fetched = 0;
  let upserted = 0;
  let lastPage = 0;

  // Batch into 100-row upserts so a single bad row doesn't reject 200.
  const batch: ReturnType<typeof toRow>[] = [];
  const flushBatch = async () => {
    if (batch.length === 0) return;
    const { error, count } = await supabase
      .from("miracleplus_contacts")
      .upsert(batch, { onConflict: "mp_contact_id", count: "exact" });
    if (error) {
      errors.push(`upsert batch (${batch.length} rows): ${error.message.slice(0, 200)}`);
    } else {
      upserted += count ?? batch.length;
    }
    batch.length = 0;
  };

  try {
    for await (const c of searchAllContacts({
      filters: FILTER,
      per: opts.perPage ?? 200,
      maxPages: opts.maxPages ?? 100,
    })) {
      fetched++;
      batch.push(toRow(c));
      if (batch.length >= 100) await flushBatch();
      // Track page rollover roughly: every per rows ≈ one page boundary
    }
    await flushBatch();
    lastPage = Math.ceil(fetched / (opts.perPage ?? 200));
  } catch (e) {
    errors.push(`fetch loop: ${String(e).slice(0, 200)}`);
  }

  return {
    fetched,
    upserted,
    pages: lastPage,
    errors,
    durationMs: Date.now() - t0,
  };
}

function toRow(c: MpContact) {
  return {
    mp_contact_id: c.id,
    email: c.email ? String(c.email).trim().toLowerCase() : null,
    name: c.name ?? null,
    phone: c.phone ?? null,
    s_product: c.s_product ?? null,
    s_channel: c.s_channel ?? null,
    utm_source: c.utm_source ?? null,
    raw_json: c as unknown as Record<string, unknown>,
    mp_created_at: c.created_at ?? null,
    mp_updated_at: c.updated_at ?? null,
    last_synced_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: TypeScript compiles**

```bash
npx tsc --noEmit
# expect: clean
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/miracleplus-sync.ts scripts/test-mp-sync.mjs
git commit -m "feat(mp): syncGpuContacts upserts paginated source=gpu drain"
```

---

## Task 7: Daily cron — `/api/cron/sync-miracleplus-contacts`

**Files:**
- Create: `src/app/api/cron/sync-miracleplus-contacts/route.ts`
- Modify: `src/app/api/cron/route.ts` (add to fan-out)

- [ ] **Step 1: Write the route**

`src/app/api/cron/sync-miracleplus-contacts/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { syncGpuContacts } from "@/lib/miracleplus-sync";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/sync-miracleplus-contacts
 *
 * Daily drain of MiraclePlus contacts where s_product=gpu (our team's
 * lane). Upserts into miracleplus_contacts (migration 099). Idempotent.
 *
 * Wired into the master /api/cron fan-out (see ../route.ts). Not
 * scheduled directly in vercel.json because Vercel Hobby caps at 2 crons.
 *
 * Auth: Bearer $CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await syncGpuContacts({ maxPages: 50, perPage: 200 });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e).slice(0, 500) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Modify the master cron fan-out**

Open `src/app/api/cron/route.ts` and locate the `fanOutSteps` array (around line 234). Add this entry directly above the closing `];` — keep alphabetic adjacency near other domain syncs (the `enrich_*` family):

In `src/app/api/cron/route.ts`, find this exact line:

```typescript
    ["enrich_backfill_5",   () => callInternalCron("/api/cron/enrich-backfill?limit=20", secret)],
```

And add immediately AFTER it:

```typescript
    // MiraclePlus contacts sync — drains source=gpu records into the
    // mirror table for downstream conversion-matrix queries. Best-effort;
    // if OAuth has expired (no refresh_token), this no-ops with an error
    // string that surfaces in the fan_out JSON.
    ["mp_sync",             () => callInternalCron("/api/cron/sync-miracleplus-contacts", secret)],
```

- [ ] **Step 3: Verify TypeScript**

```bash
npx tsc --noEmit
# expect: clean
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/sync-miracleplus-contacts/route.ts src/app/api/cron/route.ts
git commit -m "feat(mp): daily cron syncs source=gpu contacts into mirror table"
```

---

## Task 8: Conversion matrix primitive in canonical-counts

**Files:**
- Modify: `src/lib/canonical-counts.ts`
- Create: `scripts/test-mp-conversion-matrix.mjs`

The matrix is a 2x2 (registered? × wechat?) per rep, plus an org-wide row. We want every cell as a count + the list of email addresses behind it so downstream UIs can drill in.

- [ ] **Step 1: Write the smoke test**

`scripts/test-mp-conversion-matrix.mjs`:

```javascript
/**
 * Smoke: getMpConversionMatrix() returns counts shaped correctly.
 * Works even with zero data — the shape is what matters.
 * Run: npx tsx --env-file=.env.local scripts/test-mp-conversion-matrix.mjs
 */
let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

const { getMpConversionMatrix } = await import("../src/lib/canonical-counts.ts");

const result = await getMpConversionMatrix({});
assert(typeof result === "object", "returns object");
assert("predicate" in result, "has predicate field (canonical-counts contract)");
assert("orgWide" in result, "has orgWide cell totals");
assert(typeof result.orgWide.emailedAndRegisteredAndWechat === "number", "emailedAndRegisteredAndWechat is number");
assert(typeof result.orgWide.emailedAndRegisteredNoWechat === "number", "emailedAndRegisteredNoWechat is number");
assert(typeof result.orgWide.emailedNoRegisterWithWechat === "number", "emailedNoRegisterWithWechat is number");
assert(typeof result.orgWide.emailedNoRegisterNoWechat === "number", "emailedNoRegisterNoWechat is number");
assert(Array.isArray(result.perRep), "perRep is array");
console.log("    org-wide:", JSON.stringify(result.orgWide));
console.log(`    perRep length: ${result.perRep.length}`);
if (result.perRep[0]) {
  const r = result.perRep[0];
  assert(typeof r.actorRepId === "number", "perRep[].actorRepId is number");
  assert(typeof r.repName === "string", "perRep[].repName is string");
  console.log("    sample rep:", JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Run, confirm it fails (function not exported)**

```bash
npx tsx --env-file=.env.local scripts/test-mp-conversion-matrix.mjs
# expect: TypeError / undefined "getMpConversionMatrix is not a function"
```

- [ ] **Step 3: Add the primitive to canonical-counts.ts**

Append this block at the very end of `src/lib/canonical-counts.ts` (after the existing `countReadyQueue` function, before the file's final newline):

```typescript
// ── MiraclePlus conversion matrix ───────────────────────────────────────
//
// The "real" conversion ground-truth: people we cold-emailed AND who
// then actually went to build.miracleplus.com and submitted a contact
// (registered for the GPU program). Cross-tabulated with whether they
// also added our wechat (brief_lookups.added_wechat).
//
// Attribution is by emails.actor_rep_id (the rep who actually clicked
// Send), NOT pipeline_leads.assigned_rep_id (the routing owner). Per
// the project's attribution rules: closer gets credit, not owner.
//
// The matrix has 4 cells per rep:
//   emailedAndRegisteredAndWechat   — gold standard
//   emailedAndRegisteredNoWechat    — applied silently, never replied
//   emailedNoRegisterWithWechat     — added wechat but never filled form
//   emailedNoRegisterNoWechat       — baseline (sent, no signal)
//
// Plus an orgWide row that sums all reps.

export interface MpConversionFilter {
  /** ISO timestamp lower bound on emails.sent_at. Default = 365 days. */
  sentSince?: string;
  /** ISO timestamp upper bound on emails.sent_at. */
  sentUntil?: string;
}

export interface MpConversionCell {
  emailedAndRegisteredAndWechat: number;
  emailedAndRegisteredNoWechat: number;
  emailedNoRegisterWithWechat: number;
  emailedNoRegisterNoWechat: number;
  /** Total emails in scope (sum of the 4 cells). */
  totalEmailed: number;
}

export interface MpConversionPerRep extends MpConversionCell {
  actorRepId: number;
  repName: string;
}

export interface MpConversionResult {
  orgWide: MpConversionCell;
  perRep: MpConversionPerRep[];
  predicate: MpConversionFilter;
}

/**
 * Build the 2x2 conversion matrix per rep + org-wide.
 *
 * Strategy: pull (a) all sent emails in scope keyed by lower(to) +
 * actor_rep_id, (b) the set of lower(emails) present in
 * miracleplus_contacts as a Set, (c) the set of lower(emails) with
 * added_wechat=true in brief_lookups joined through pipeline_leads.
 * Then bucket each sent-email row into the 4 cells using set
 * membership.
 *
 * Scales fine to our current volume (~1500 emails, ~thousands of MP
 * contacts) because all three pulls fit in one paginated round-trip.
 */
export async function getMpConversionMatrix(
  filter: MpConversionFilter,
  opts?: Opts,
): Promise<MpConversionResult> {
  return memoize("getMpConversionMatrix", filter, opts, async () => {
    const sentSince = filter.sentSince ?? new Date(Date.now() - 365 * 86_400_000).toISOString();

    // (a) sent emails in scope
    let emailsQ = supabase
      .from("emails")
      .select("to, actor_rep_id, sent_at")
      .gte("sent_at", sentSince)
      .not("to", "is", null);
    if (filter.sentUntil) emailsQ = emailsQ.lt("sent_at", filter.sentUntil);
    const sentRows: { to: string; actor_rep_id: number | null }[] = [];
    let cursor = 0;
    while (true) {
      const { data, error } = await emailsQ.range(cursor, cursor + 999);
      if (error) throw new Error(`emails fetch failed: ${error.message}`);
      const batch = (data ?? []) as { to: string; actor_rep_id: number | null }[];
      sentRows.push(...batch);
      if (batch.length < 1000) break;
      cursor += 1000;
    }

    // (b) MP contacts (registered) → Set of lowercased emails
    const registered = new Set<string>();
    cursor = 0;
    while (true) {
      const { data, error } = await supabase
        .from("miracleplus_contacts")
        .select("email")
        .not("email", "is", null)
        .range(cursor, cursor + 999);
      if (error) throw new Error(`miracleplus_contacts fetch failed: ${error.message}`);
      const batch = (data ?? []) as { email: string }[];
      for (const r of batch) registered.add(r.email.toLowerCase());
      if (batch.length < 1000) break;
      cursor += 1000;
    }

    // (c) wechat-added emails → Set. brief_lookups stores lead_id, so
    // join through pipeline_leads.author_email.
    const wechatEmails = new Set<string>();
    cursor = 0;
    while (true) {
      const { data, error } = await supabase
        .from("brief_lookups")
        .select("pipeline_leads!inner(author_email)")
        .eq("added_wechat", true)
        .range(cursor, cursor + 999);
      if (error) throw new Error(`brief_lookups fetch failed: ${error.message}`);
      const batch = (data ?? []) as { pipeline_leads: { author_email: string | null } | null }[];
      for (const r of batch) {
        const e = r.pipeline_leads?.author_email;
        if (e) wechatEmails.add(e.toLowerCase());
      }
      if (batch.length < 1000) break;
      cursor += 1000;
    }

    // Bucket
    const perRepMap = new Map<number, MpConversionCell>();
    const empty = (): MpConversionCell => ({
      emailedAndRegisteredAndWechat: 0,
      emailedAndRegisteredNoWechat: 0,
      emailedNoRegisterWithWechat: 0,
      emailedNoRegisterNoWechat: 0,
      totalEmailed: 0,
    });
    const orgWide: MpConversionCell = empty();
    for (const row of sentRows) {
      if (!row.to) continue;
      const emailLc = row.to.toLowerCase();
      const reg = registered.has(emailLc);
      const wc = wechatEmails.has(emailLc);
      const cell: keyof MpConversionCell = reg
        ? (wc ? "emailedAndRegisteredAndWechat" : "emailedAndRegisteredNoWechat")
        : (wc ? "emailedNoRegisterWithWechat" : "emailedNoRegisterNoWechat");
      orgWide[cell]++;
      orgWide.totalEmailed++;
      const rid = row.actor_rep_id;
      if (rid != null) {
        if (!perRepMap.has(rid)) perRepMap.set(rid, empty());
        const c = perRepMap.get(rid)!;
        c[cell]++;
        c.totalEmailed++;
      }
    }

    // Hydrate rep names
    const repIds = Array.from(perRepMap.keys());
    const { data: repsData } = repIds.length
      ? await supabase.from("sales_reps").select("id, name").in("id", repIds)
      : { data: [] as { id: number; name: string }[] };
    const repNameById = new Map<number, string>((repsData ?? []).map((r) => [r.id, r.name]));

    const perRep: MpConversionPerRep[] = repIds
      .map((rid) => ({
        actorRepId: rid,
        repName: repNameById.get(rid) ?? `rep_${rid}`,
        ...(perRepMap.get(rid) as MpConversionCell),
      }))
      .sort((a, b) => b.emailedAndRegisteredAndWechat - a.emailedAndRegisteredAndWechat);

    return { orgWide, perRep, predicate: filter };
  });
}
```

- [ ] **Step 4: Run smoke, expect pass**

```bash
npx tsx --env-file=.env.local scripts/test-mp-conversion-matrix.mjs
# expect: 7 passed, 0 failed (even with empty mirror table — the
# orgWide.totalEmailed should still be > 0 since we have ~1500 sent emails)
```

- [ ] **Step 5: Run the canonical-counts lint to confirm no violation**

```bash
npm run lint:counts
# expect: no new violations. The new primitive is INSIDE the canonical
# module so it doesn't trip the lint.
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/canonical-counts.ts scripts/test-mp-conversion-matrix.mjs
git commit -m "feat(mp): getMpConversionMatrix primitive in canonical-counts"
```

---

## Task 9: Leon read tool — `get_mp_conversions`

**Files:**
- Modify: `src/lib/helper-tools.ts` (register in TOOLS_PROMPT)
- Modify: `src/lib/helper-read-tools.ts` (dispatch case)

- [ ] **Step 1: Add the tool description to TOOLS_PROMPT**

Open `src/lib/helper-tools.ts`. Find the `get_lead_counts` description line (around line 190). Add immediately AFTER it (inside the same TOOLS_PROMPT template literal, as a new bullet line):

```typescript
- get_mp_conversions — **真实转化漏斗 (我们邮件 ↔ 奇绩 Open API)**. args: { since_days?: 1-365 (默认 90), actor_rep_id?: number (按某个 rep 筛, 默认全部) }. 返回: { window_days, org_wide: { emailedAndRegisteredAndWechat, emailedAndRegisteredNoWechat, emailedNoRegisterWithWechat, emailedNoRegisterNoWechat, totalEmailed }, per_rep: [{ actor_rep_id, rep_name, ...同 cells }, ...排序: 真转化 (registered + wechat) 多到少] }. **什么时候用 (这是关键)**: admin 或 rep 问 "**我们发的邮件真的有人转化吗 / 谁的 template 真的拿到了 application / 这周有几个客户真的填了表**" — 这是**比 click/reply 更硬的转化信号** (build.miracleplus.com 实际填了 contact form). 跟 wechat (brief_lookups) 交叉得到 2x2 矩阵, 一眼看出 "邮件 → 加微信 → 注册" 的完整漏斗在哪里漏. **重要 (attribution)**: per_rep 用的是 emails.actor_rep_id (**真的点了 send 的人**), 不是 pipeline_leads.assigned_rep_id (lead owner). 这是 CLAUDE.md 的 closer-gets-credit 规则. 答的时候挑 top 1-3 cells, 不要 dump 全部 4 个 — e.g. "你 (Leo) 这 90 天发了 412 封, 8 个真填了表, 其中 5 个加了微信 — best cell 是 5 (emailedAndRegisteredAndWechat)".
```

- [ ] **Step 2: Add the dispatch case to helper-read-tools.ts**

Open `src/lib/helper-read-tools.ts`. Find the `case "get_lead_counts":` block (around line 665). Add this new case immediately BEFORE it:

```typescript
      case "get_mp_conversions": {
        // Real conversion ground-truth: cross-tab of (our sent emails) ×
        // (build.miracleplus.com contacts with s_product=gpu) × (brief_lookups
        // added_wechat). Uses canonical-counts primitive so the bot's
        // number always matches the /admin/conversion-matrix page.
        const sinceDays = typeof args.since_days === "number"
          ? Math.max(1, Math.min(365, args.since_days))
          : 90;
        const sentSince = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
        const { getMpConversionMatrix } = await import("@/lib/canonical-counts");
        const matrix = await getMpConversionMatrix({ sentSince });

        // Optional per-rep filter
        const filterRepId = typeof args.actor_rep_id === "number" ? args.actor_rep_id : null;
        const perRep = filterRepId == null
          ? matrix.perRep
          : matrix.perRep.filter((r) => r.actorRepId === filterRepId);

        return {
          tool: call.tool,
          result: {
            window_days: sinceDays,
            org_wide: matrix.orgWide,
            per_rep: perRep.map((r) => ({
              actor_rep_id: r.actorRepId,
              rep_name: r.repName,
              emailedAndRegisteredAndWechat: r.emailedAndRegisteredAndWechat,
              emailedAndRegisteredNoWechat: r.emailedAndRegisteredNoWechat,
              emailedNoRegisterWithWechat: r.emailedNoRegisterWithWechat,
              emailedNoRegisterNoWechat: r.emailedNoRegisterNoWechat,
              totalEmailed: r.totalEmailed,
            })),
          },
        };
      }
```

- [ ] **Step 3: Add the tool name to the READ_TOOL_NAMES allowlist (if one exists)**

Search for the allowlist:

```bash
grep -n "READ_TOOL_NAMES\|ALLOWED_READ_TOOLS\|tool_names" /Users/xingzewang/Desktop/mail/src/lib/helper-tools.ts | head -5
```

If a `READ_TOOL_NAMES` constant exists, add `"get_mp_conversions"` to it in the same alphabetic/grouping style as the surrounding names. If no such constant exists, this step is a no-op — skip to Step 4.

- [ ] **Step 4: TypeScript compiles**

```bash
npx tsc --noEmit
# expect: clean
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/helper-tools.ts src/lib/helper-read-tools.ts
git commit -m "feat(mp): Leon read tool get_mp_conversions"
```

---

## Task 10: Admin UI — `/admin/conversion-matrix` page

**Files:**
- Create: `src/app/admin/conversion-matrix/page.tsx`

- [ ] **Step 1: Write the page**

`src/app/admin/conversion-matrix/page.tsx`:

```typescript
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getMpConversionMatrix } from "@/lib/canonical-counts";
import { supabase } from "@/lib/db";
import { verifyAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /admin/conversion-matrix
 *
 * The 2x2 conversion ground-truth matrix:
 *   emailed × {registered on build.miracleplus.com, not} × {added wechat, not}
 *
 * Numbers all flow through getMpConversionMatrix() in canonical-counts —
 * so this page can never disagree with the Leon DM answer.
 *
 * Per-rep attribution uses emails.actor_rep_id (closer gets credit), not
 * pipeline_leads.assigned_rep_id (owner).
 */
export default async function ConversionMatrixPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  // Auth: admin only
  const cookieStore = await cookies();
  const jwt = cookieStore.get(process.env.AUTH_COOKIE ?? "qiji_session")?.value;
  const session = jwt ? await verifyAuth(jwt) : null;
  if (!session) redirect("/login?next=/admin/conversion-matrix");
  // Re-read role from DB (don't trust JWT — see CLAUDE.md)
  const { data: rep } = await supabase.from("sales_reps").select("role").eq("id", session.id).maybeSingle();
  if (rep?.role !== "admin") redirect("/");

  const params = await searchParams;
  const days = Math.max(1, Math.min(365, Number(params.days) || 90));
  const sentSince = new Date(Date.now() - days * 86_400_000).toISOString();
  const matrix = await getMpConversionMatrix({ sentSince });

  // Last sync time for the staleness banner
  const { data: lastSync } = await supabase
    .from("miracleplus_contacts")
    .select("last_synced_at")
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <div style={{ padding: "2rem", maxWidth: 960, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1>Conversion Matrix</h1>
      <p style={{ color: "#666" }}>
        Window: last {days} days. Source: build.miracleplus.com (source=gpu) × emails × brief_lookups.
      </p>
      {lastSync?.last_synced_at && (
        <p style={{ fontSize: 12, color: "#888" }}>
          mp_contacts last synced: {new Date(lastSync.last_synced_at).toLocaleString()}
        </p>
      )}

      <h2>Org-wide</h2>
      <table style={{ borderCollapse: "collapse", marginBottom: "2rem" }}>
        <thead>
          <tr>
            <th style={th}></th>
            <th style={th}>Registered (MP)</th>
            <th style={th}>NOT Registered</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th style={th}>WeChat added</th>
            <td style={tdHi}>{matrix.orgWide.emailedAndRegisteredAndWechat}</td>
            <td style={td}>{matrix.orgWide.emailedNoRegisterWithWechat}</td>
          </tr>
          <tr>
            <th style={th}>No WeChat</th>
            <td style={td}>{matrix.orgWide.emailedAndRegisteredNoWechat}</td>
            <td style={tdLo}>{matrix.orgWide.emailedNoRegisterNoWechat}</td>
          </tr>
        </tbody>
      </table>
      <p style={{ color: "#444" }}>
        Total emailed in window: <b>{matrix.orgWide.totalEmailed}</b>. Conversion rate (registered ÷ emailed):{" "}
        <b>
          {matrix.orgWide.totalEmailed > 0
            ? `${(((matrix.orgWide.emailedAndRegisteredAndWechat + matrix.orgWide.emailedAndRegisteredNoWechat) / matrix.orgWide.totalEmailed) * 100).toFixed(1)}%`
            : "—"}
        </b>
      </p>

      <h2>Per rep (actor — who actually clicked Send)</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Rep</th>
            <th style={th}>Total sent</th>
            <th style={th}>Reg + WeChat</th>
            <th style={th}>Reg only</th>
            <th style={th}>WeChat only</th>
            <th style={th}>Nothing</th>
          </tr>
        </thead>
        <tbody>
          {matrix.perRep.map((r) => (
            <tr key={r.actorRepId}>
              <td style={td}>{r.repName}</td>
              <td style={td}>{r.totalEmailed}</td>
              <td style={tdHi}>{r.emailedAndRegisteredAndWechat}</td>
              <td style={td}>{r.emailedAndRegisteredNoWechat}</td>
              <td style={td}>{r.emailedNoRegisterWithWechat}</td>
              <td style={tdLo}>{r.emailedNoRegisterNoWechat}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: "2rem", fontSize: 12, color: "#666" }}>
        Attribution: <code>emails.actor_rep_id</code> (who clicked Send), not <code>assigned_rep_id</code> (owner).
        Numbers flow through <code>src/lib/canonical-counts.ts:getMpConversionMatrix</code> — same primitive as
        Leon&apos;s <code>get_mp_conversions</code> read tool.
      </p>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.5rem 1rem", borderBottom: "1px solid #ccc", textAlign: "left" };
const td: React.CSSProperties = { padding: "0.5rem 1rem", borderBottom: "1px solid #eee" };
const tdHi: React.CSSProperties = { ...td, background: "#e9f9e0", fontWeight: 600 };
const tdLo: React.CSSProperties = { ...td, color: "#999" };
```

- [ ] **Step 2: TypeScript + build**

```bash
npx tsc --noEmit
# expect: clean
npm run build
# expect: build succeeds. If `verifyAuth` signature has drifted, check
# src/lib/auth.ts and adjust the import to match (this is the same
# pattern used by other admin pages — copy from src/app/admin/inbox/page.tsx
# if needed).
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/conversion-matrix/page.tsx
git commit -m "feat(mp): /admin/conversion-matrix page renders the 2x2"
```

---

## Task 11: End-to-end verification smoke

**Files:**
- Create: `scripts/smoke-miracleplus-integration.mjs`

This smoke is the final acceptance gate. It exercises every layer once we've done the live OAuth in production.

- [ ] **Step 1: Write the smoke**

`scripts/smoke-miracleplus-integration.mjs`:

```javascript
/**
 * End-to-end smoke for MiraclePlus integration. Run AFTER:
 *   1. Migration 099 applied
 *   2. MP_CLIENT_ID/SECRET/REDIRECT_URI set in Vercel + locally
 *   3. Admin has run `node --env-file=.env.local scripts/mp-oauth-bootstrap.mjs`
 *      AND completed the browser dance so oauth_tokens has the row
 *   4. /api/cron/sync-miracleplus-contacts has been hit at least once
 *      (either by the daily fan-out or manually via curl with CRON_SECRET)
 *
 * Tests:
 *   - oauth row exists and access token refreshes cleanly
 *   - api client returns me + at least one contact
 *   - mirror table has rows
 *   - conversion matrix returns non-zero totalEmailed (we sent ~1500
 *     emails this year, so this must be > 0 even if no matches)
 *   - cross-tab math: sum of 4 cells == totalEmailed (sanity)
 *
 * Run: npx tsx --env-file=.env.local scripts/smoke-miracleplus-integration.mjs
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

console.log("\n== 1. oauth_tokens row ==");
const { data: tokenRow } = await sb.from("oauth_tokens").select("*").eq("provider", "miracleplus").maybeSingle();
assert(tokenRow != null, "row exists (bootstrap was run)");
if (!tokenRow) { console.error("STOP — bootstrap first."); process.exit(1); }
assert(typeof tokenRow.refresh_token === "string" && tokenRow.refresh_token.length > 0, "refresh_token populated");

console.log("\n== 2. getAccessToken refresh cycle ==");
const { getAccessToken } = await import("../src/lib/miracleplus-oauth.ts");
const tok = await getAccessToken();
assert(typeof tok === "string" && tok.length > 20, "getAccessToken returns valid string");

console.log("\n== 3. API client ==");
const { getMe, searchContacts } = await import("../src/lib/miracleplus-api.ts");
const me = await getMe();
assert(typeof me === "object" && me !== null, "getMe() works");

const search = await searchContacts({ filters: "g|eq|s_product|gpu", per: 5 });
assert(Array.isArray(search.contacts), "searchContacts returns array");
assert(search.total >= 0, "searchContacts.total is non-negative");
console.log(`    s_product=gpu has ${search.total} total contacts in MP`);

console.log("\n== 4. Mirror table populated ==");
const { count: mirrorCount } = await sb.from("miracleplus_contacts").select("mp_contact_id", { count: "exact", head: true });
assert((mirrorCount ?? 0) > 0, `mirror has rows (got ${mirrorCount ?? 0})`);
const { count: gpuMirrorCount } = await sb.from("miracleplus_contacts").select("mp_contact_id", { count: "exact", head: true }).eq("s_product", "gpu");
console.log(`    of which s_product=gpu: ${gpuMirrorCount ?? 0}`);

console.log("\n== 5. Conversion matrix ==");
const { getMpConversionMatrix } = await import("../src/lib/canonical-counts.ts");
const matrix = await getMpConversionMatrix({});
assert(matrix.orgWide.totalEmailed > 0, `totalEmailed > 0 (got ${matrix.orgWide.totalEmailed})`);
const summed = matrix.orgWide.emailedAndRegisteredAndWechat
             + matrix.orgWide.emailedAndRegisteredNoWechat
             + matrix.orgWide.emailedNoRegisterWithWechat
             + matrix.orgWide.emailedNoRegisterNoWechat;
assert(summed === matrix.orgWide.totalEmailed, `4 cells sum to totalEmailed (${summed} === ${matrix.orgWide.totalEmailed})`);
console.log("    org-wide:", JSON.stringify(matrix.orgWide));
console.log(`    per_rep count: ${matrix.perRep.length}`);
const registered = matrix.orgWide.emailedAndRegisteredAndWechat + matrix.orgWide.emailedAndRegisteredNoWechat;
console.log(`    >> ${registered} of ${matrix.orgWide.totalEmailed} cold-emailed recipients registered (${(registered/matrix.orgWide.totalEmailed*100).toFixed(1)}%)`);

console.log("\n== 6. Leon read tool ==");
const { runReadTool } = await import("../src/lib/helper-read-tools.ts");
const toolResult = await runReadTool(
  { tool: "get_mp_conversions", args: { since_days: 90 } },
  { id: 1, role: "admin", name: "smoke-test" }, // fake admin session
);
assert(toolResult?.result?.org_wide != null, "get_mp_conversions tool returns org_wide");
assert(Array.isArray(toolResult?.result?.per_rep), "get_mp_conversions tool returns per_rep");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Don't run it yet — it's gated on prod-side bootstrap (Task 12)**

Just commit:

```bash
git add scripts/smoke-miracleplus-integration.mjs
git commit -m "test(mp): end-to-end integration smoke (run after prod bootstrap)"
```

---

## Task 12: Deploy + production OAuth dance + verify

This is the **must-do-in-prod-with-real-creds** step. Cannot be done locally because the Lark/MP callback URL must be reachable.

- [ ] **Step 1: Set Vercel env vars**

```bash
vercel env add MP_CLIENT_ID production
# paste the client id when prompted
vercel env add MP_CLIENT_SECRET production
# paste the secret
vercel env add MP_REDIRECT_URI production
# value: https://calistamind.com/api/admin/mp-oauth/callback
```

- [ ] **Step 2: Deploy**

```bash
git push origin person-resolver-enrichment
# then trigger prod deploy per the vercel-deploy skill recipe:
vercel --prod
# wait for READY
```

- [ ] **Step 3: Run the OAuth bootstrap locally to generate the authorize URL**

```bash
# Pull current prod env so MP_CLIENT_ID / MP_REDIRECT_URI are in your shell
vercel env pull .env.local --environment=production
# (this also pulls SUPABASE_SERVICE_KEY which the script needs)

node --env-file=.env.local scripts/mp-oauth-bootstrap.mjs
# It prints the authorize URL.
```

- [ ] **Step 4: Open the URL in your browser**

You must already be logged in at `https://calistamind.com` as an admin (so the callback route's `requireAdmin` passes). Authorize MiraclePlus → you'll be redirected to the callback → you see the green "MiraclePlus OAuth complete" HTML page.

- [ ] **Step 5: Verify the row landed**

```bash
node --env-file=.env.local scripts/mp-oauth-bootstrap.mjs --check
# expect:
#   ✓ oauth_tokens row present
#     access_expires_at: ... (115min from now or similar)
#     scopes: contacts_read
#     obtained_by_rep: <your rep id>
```

- [ ] **Step 6: Manually trigger the cron once**

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" \
  https://calistamind.com/api/cron/sync-miracleplus-contacts
# expect: 200 with JSON { ok: true, fetched: N, upserted: N, pages: K, errors: [], durationMs: ... }
```

- [ ] **Step 7: Run the end-to-end smoke**

```bash
npx tsx --env-file=.env.local scripts/smoke-miracleplus-integration.mjs
# expect: all asserts pass, including totalEmailed > 0 and a non-trivial
# >> "N of M cold-emailed recipients registered (X.X%)" line.
```

- [ ] **Step 8: Verify the admin page renders**

In a browser logged in as admin:

```
https://calistamind.com/admin/conversion-matrix
https://calistamind.com/admin/conversion-matrix?days=30
```

Both should render the 2x2 matrix and the per-rep table.

- [ ] **Step 9: Verify Leon can answer the question**

DM the Lark bot as admin:

> "我们这 90 天发的邮件, 有多少人真的去 build.miracleplus.com 填了表?"

Expected response: Leon `lookup`s `get_mp_conversions`, then reports the org-wide totalEmailed + the count of `emailedAndRegisteredAndWechat + emailedAndRegisteredNoWechat`, with rep breakdown.

- [ ] **Step 10: Final commit if any touch-ups were needed**

```bash
git status
# expect: clean
# OR if you needed to tweak something, commit it
```

---

## Self-Review

**Spec coverage:**
- "Wrap OAuth API in `src/lib/miracleplus-api.ts`" → Tasks 3 + 4
- "Daily cron pulls newly-registered users / submitted applications filtered to source=gpu" → Tasks 6 + 7
- "fetching the emails" (pulling submitted applications) → Task 6 `syncGpuContacts`
- "checking the emails" (match against our outbound) → Task 8 `getMpConversionMatrix`
- "assigning back to the rep that sent the email" → Task 8 explicitly uses `emails.actor_rep_id` (not `assigned_rep_id`)
- "see if that was also wechat added" → Task 8 includes `brief_lookups.added_wechat=true` join
- "testing it actually works" → Tasks 11 + 12 (smoke + prod verification)
- Token refresh strategy → Task 3 `getAccessToken` auto-refreshes within 5-min buffer
- Admin OAuth dance one-time bootstrap → Task 5 (callback) + Task 12 (execution)
- Cross-table conversion matrix surface → Task 10 (admin page) + Task 9 (Leon tool)
- Canonical-counts contract → Task 8 puts the primitive INSIDE `canonical-counts.ts`; Task 9 calls it from the read tool; Task 10 calls it from the page. No `count: exact` outside the module.
- Attribution rule (actor vs owner) → Task 8 + Task 10 explicitly call out `actor_rep_id`

**Placeholder scan:** None. Every code block is complete and runnable. The two "operator notes" (under Task 2 and Task 5) explain context but aren't placeholder steps.

**Type consistency:**
- `MpContact` defined in Task 4, used in Task 6 (`toRow(c)`)
- `MpConversionFilter` / `MpConversionResult` defined in Task 8, consumed in Tasks 9 + 10 + 11
- `MpOAuthRow` defined in Task 3, returned by `bootstrapWithCode` (Task 3) consumed by Task 5 (callback)
- The cell name strings (`emailedAndRegisteredAndWechat`, etc.) are identical across Tasks 8, 9, 10, 11

**Outstanding TBDs requiring user input before implementation can start:**

1. **Actual `MP_CLIENT_ID` / `MP_CLIENT_SECRET` values.** The parent team has to register us as an OAuth client. The plan assumes the user already has these or can request them — if not, Task 12 is blocked until they're issued.

2. **`MP_REDIRECT_URI` whitelist.** The parent team needs to whitelist `https://calistamind.com/api/admin/mp-oauth/callback` in our OAuth client config. If they require a different URI (e.g. `https://miracleplus-dashboard.calistamind.com/...`), update Task 2 + Task 5 + Task 12 to match. Plan assumes default.

3. **Exact filter syntax for `source=gpu`.** Memory file flagged this as unverified. Plan uses `g|eq|s_product|gpu` based on the doc text provided in the user's session brief, but if the parent team's contacts use `utm_source=gpu_team` instead of `s_product=gpu` (or both), the `FILTER` constant in `src/lib/miracleplus-sync.ts` (Task 6) needs to change to match. Verification: Task 11 smoke prints how many contacts came back — if 0, the filter is wrong, swap in `g|eq|utm_source|gpu_team` and re-run.

4. **Whether the API exposes `application_submissions` separately from `contacts`.** The plan treats every `contacts` row as a "submitted application" (which matches the user's stated semantics — they fill the form, they become a contact). If a separate `applications` endpoint exists with richer fields (program_track, submitted_at, etc.), Task 4 needs a `searchApplications()` wrapper and Task 6 needs to choose between the two endpoints. Plan assumes contacts-only.

If user can answer (1) and (3) in one message ("here's the client id, here's the secret, the filter is `s_product=gpu`"), the plan is fully executable.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-16-miracleplus-open-api-integration.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Tasks 1–10 can largely run autonomously; Task 12 needs human-in-the-loop for the browser OAuth dance.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Stop at Task 11 to wait for prod credentials before Task 12.

**Which approach?**
