# Lead Assignment & Sales Rep System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Semantic Scholar enrichment, multi-rep sales assignment, and pipeline analytics tabs so leads are auto-classified (strong/normal), assigned to reps, and sent with rep-specific identity.

**Architecture:** New DB tables (`sales_reps`, `system_config`) + new columns on `pipeline_leads`. New lib modules for S2 lookup and assignment logic. Scanner pipeline extended: scan → S2 enrich → classify → assign → generate draft with rep identity. Pipeline page gets 3 tabs (Leads, Channels, Sales) with analytics queries from existing data.

**Tech Stack:** Next.js 16, Supabase (PostgreSQL), Semantic Scholar API, Recharts (existing), Tailwind CSS, Radix UI (existing)

---

## File Map

### New files
- `src/lib/semantic-scholar.ts` — S2 API client (paper search, author lookup)
- `src/lib/assignment.ts` — classify lead tier + assign to rep
- `src/app/api/sales-reps/route.ts` — CRUD for sales reps
- `src/app/api/config/assignment/route.ts` — GET/PUT assignment rules
- `src/app/api/pipeline/analytics/route.ts` — channel + sales analytics data
- `src/app/api/migrate/lead-assignment/route.ts` — DB migration endpoint

### Modified files
- `src/lib/scanner.ts` — add S2 enrichment call after Gemini analysis
- `src/lib/email-generator.ts` — accept rep identity in `generateDraft()`
- `src/app/api/pipeline/route.ts` — add S2+assign to POST, add tier/rep filters to GET, return new fields
- `src/app/api/pipeline/[id]/route.ts` — support `assigned_rep_id` in PATCH
- `src/app/api/pipeline/send/route.ts` — look up assigned rep, use their sender identity
- `src/app/api/pipeline/batch-send/route.ts` — same per-lead rep identity
- `src/app/pipeline/page.tsx` — 3 tabs, lead tier badges, h-index, rep dropdown, batch banner

---

## Task 1: DB Migration

**Files:**
- Create: `src/app/api/migrate/lead-assignment/route.ts`

- [ ] **Step 1: Create migration endpoint**

```ts
// src/app/api/migrate/lead-assignment/route.ts
import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function POST() {
  const results: string[] = [];

  // 1. sales_reps table
  const { error: e1 } = await supabase.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS sales_reps (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        wechat_id TEXT NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `,
  });
  results.push(e1 ? `sales_reps: ${e1.message}` : "sales_reps: OK");

  // 2. system_config table
  const { error: e2 } = await supabase.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `,
  });
  results.push(e2 ? `system_config: ${e2.message}` : "system_config: OK");

  // 3. Add columns to pipeline_leads
  const columns = [
    { name: "s2_author_id", type: "TEXT" },
    { name: "h_index", type: "INTEGER" },
    { name: "citation_count", type: "INTEGER" },
    { name: "paper_count", type: "INTEGER" },
    { name: "lead_tier", type: "TEXT DEFAULT 'normal'" },
    { name: "assigned_rep_id", type: "INTEGER" },
  ];

  for (const col of columns) {
    const { error } = await supabase.rpc("exec_sql", {
      sql: `ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};`,
    });
    results.push(error ? `${col.name}: ${error.message}` : `${col.name}: OK`);
  }

  // 4. Seed Leo as first rep
  const { error: e3 } = await supabase
    .from("sales_reps")
    .upsert(
      {
        id: 1,
        name: "Leo",
        sender_email: "leo@compute.miracleplus.com",
        sender_name: "Leo",
        wechat_id: "Lorenserus1",
        active: true,
      },
      { onConflict: "id" },
    );
  results.push(e3 ? `seed leo: ${e3.message}` : "seed leo: OK");

  // 5. Seed default assignment config
  const defaultConfig = {
    strong_criteria: {
      min_h_index: 20,
      max_school_tier: 2,
      require_overseas: true,
    },
    assignment: {
      strong: { rep_id: 1 },
      normal: { rep_ids: [1], mode: "round_robin" },
    },
  };

  const { error: e4 } = await supabase
    .from("system_config")
    .upsert(
      { key: "lead_assignment", value: defaultConfig },
      { onConflict: "key" },
    );
  results.push(e4 ? `seed config: ${e4.message}` : "seed config: OK");

  return NextResponse.json({ results });
}
```

- [ ] **Step 2: Run migration**

```
curl -X POST http://localhost:3333/api/migrate/lead-assignment
```

Expected: all results show "OK".

- [ ] **Step 3: Commit**

```bash
git add src/app/api/migrate/lead-assignment/route.ts
git commit -m "feat: add DB migration for lead assignment tables and columns"
```

---

## Task 2: Semantic Scholar Client

**Files:**
- Create: `src/lib/semantic-scholar.ts`

- [ ] **Step 1: Create S2 client**

```ts
// src/lib/semantic-scholar.ts

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_DELAY_MS = 1100; // stay under 1 req/sec

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface S2AuthorInfo {
  authorId: string;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
}

/**
 * Look up a paper on Semantic Scholar by title, then find the matching
 * author and return their h-index and citation count.
 *
 * Returns null if paper not found, author not matched, or API error.
 */
export async function lookupAuthor(
  paperTitle: string,
  authorName: string,
): Promise<S2AuthorInfo | null> {
  try {
    // Step 1: search for the paper by title
    const query = encodeURIComponent(paperTitle.slice(0, 200));
    const paperRes = await fetch(
      `${S2_BASE}/paper/search?query=${query}&limit=3&fields=title,authors`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!paperRes.ok) return null;
    const paperData = await paperRes.json();
    const papers = paperData?.data ?? [];
    if (papers.length === 0) return null;

    // Step 2: find matching author across results
    const normalizedTarget = authorName.toLowerCase().replace(/\s+/g, " ").trim();
    let matchedAuthorId: string | null = null;

    for (const paper of papers) {
      for (const author of paper.authors ?? []) {
        const normalizedAuthor = (author.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
        // Check substring match in both directions (handles name order differences)
        const targetParts = normalizedTarget.split(" ");
        const authorParts = normalizedAuthor.split(" ");
        const allTargetPartsMatch = targetParts.every((p: string) =>
          authorParts.some((a: string) => a === p),
        );
        if (allTargetPartsMatch && author.authorId) {
          matchedAuthorId = author.authorId;
          break;
        }
      }
      if (matchedAuthorId) break;
    }

    if (!matchedAuthorId) return null;

    // Step 3: fetch author details
    await sleep(S2_DELAY_MS);
    const authorRes = await fetch(
      `${S2_BASE}/author/${matchedAuthorId}?fields=hIndex,citationCount,paperCount`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!authorRes.ok) return null;
    const authorData = await authorRes.json();

    return {
      authorId: matchedAuthorId,
      hIndex: authorData.hIndex ?? null,
      citationCount: authorData.citationCount ?? null,
      paperCount: authorData.paperCount ?? null,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/semantic-scholar.ts
git commit -m "feat: add Semantic Scholar API client for author lookup"
```

---

## Task 3: Assignment Engine

**Files:**
- Create: `src/lib/assignment.ts`

- [ ] **Step 1: Create assignment module**

```ts
// src/lib/assignment.ts

import { supabase } from "@/lib/db";

export interface AssignmentConfig {
  strong_criteria: {
    min_h_index: number;
    max_school_tier: number;
    require_overseas: boolean;
  };
  assignment: {
    strong: { rep_id: number };
    normal: { rep_ids: number[]; mode: "round_robin" };
  };
}

export interface SalesRep {
  id: number;
  name: string;
  sender_email: string;
  sender_name: string;
  wechat_id: string;
  active: boolean;
}

// Round-robin counter (in-memory, resets on deploy — acceptable)
let rrIndex = 0;

/**
 * Load assignment config from system_config table.
 * Falls back to safe defaults if not found.
 */
export async function getAssignmentConfig(): Promise<AssignmentConfig> {
  const { data } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "lead_assignment")
    .single();

  if (data?.value) return data.value as AssignmentConfig;

  return {
    strong_criteria: { min_h_index: 20, max_school_tier: 2, require_overseas: true },
    assignment: { strong: { rep_id: 1 }, normal: { rep_ids: [1], mode: "round_robin" } },
  };
}

/**
 * Load a sales rep by ID. Returns null if not found or inactive.
 */
export async function getRep(id: number): Promise<SalesRep | null> {
  const { data } = await supabase
    .from("sales_reps")
    .select("*")
    .eq("id", id)
    .eq("active", true)
    .single();

  return data as SalesRep | null;
}

/**
 * Load all active sales reps.
 */
export async function getAllReps(): Promise<SalesRep[]> {
  const { data } = await supabase
    .from("sales_reps")
    .select("*")
    .eq("active", true)
    .order("id");

  return (data ?? []) as SalesRep[];
}

/**
 * Determine if a school domain is overseas (not .cn).
 */
function isOverseas(email: string): boolean {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  return !domain.endsWith(".cn");
}

/**
 * Classify a lead as 'strong' or 'normal' based on assignment config.
 */
export function classifyLead(
  config: AssignmentConfig,
  lead: {
    hIndex: number | null;
    schoolTier: number | null;
    authorEmail: string;
  },
): "strong" | "normal" {
  const { min_h_index, max_school_tier, require_overseas } = config.strong_criteria;

  if (lead.hIndex === null || lead.hIndex < min_h_index) return "normal";
  if (lead.schoolTier === null || lead.schoolTier > max_school_tier) return "normal";
  if (require_overseas && !isOverseas(lead.authorEmail)) return "normal";

  return "strong";
}

/**
 * Pick the rep ID for a lead based on its tier and the assignment config.
 */
export function assignRep(
  config: AssignmentConfig,
  tier: "strong" | "normal",
): number {
  if (tier === "strong") {
    return config.assignment.strong.rep_id;
  }

  const repIds = config.assignment.normal.rep_ids;
  if (repIds.length === 0) return config.assignment.strong.rep_id; // fallback
  if (repIds.length === 1) return repIds[0];

  const chosen = repIds[rrIndex % repIds.length];
  rrIndex++;
  return chosen;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/assignment.ts
git commit -m "feat: add lead classification and rep assignment engine"
```

---

## Task 4: Wire S2 + Assignment into Scanner Pipeline

**Files:**
- Modify: `src/lib/scanner.ts` — add S2 enrichment fields to `ScannedLead`
- Modify: `src/app/api/pipeline/route.ts` — call S2 + assignment after scan, pass rep to draft gen

- [ ] **Step 1: Extend ScannedLead type in scanner.ts**

Add these fields to the `ScannedLead` interface in `src/lib/scanner.ts`:

```ts
// Add to ScannedLead interface (after matchedDirections)
  s2AuthorId: string | null;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
```

And in the `leads.push(...)` block (around line 746), add defaults:

```ts
          s2AuthorId: null,
          hIndex: null,
          citationCount: null,
          paperCount: null,
```

- [ ] **Step 2: Update pipeline POST route to enrich + classify + assign**

Replace the `POST` handler in `src/app/api/pipeline/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { scanArxiv, type ScannedLead } from "@/lib/scanner";
import { generateDraft } from "@/lib/email-generator";
import { lookupAuthor } from "@/lib/semantic-scholar";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
} from "@/lib/assignment";

// ... keep existing GET handler and insertLead unchanged ...

// Update insertLead to include new fields:
async function insertLead(
  lead: ScannedLead,
  draft: { subject: string; html: string } | null,
  extras: {
    s2AuthorId?: string | null;
    hIndex?: number | null;
    citationCount?: number | null;
    paperCount?: number | null;
    leadTier?: string;
    assignedRepId?: number;
  },
) {
  return supabase.from("pipeline_leads").insert({
    arxiv_id: lead.arxivId,
    title: lead.title,
    abstract: lead.abstract,
    authors: lead.authors,
    pdf_url: lead.pdfUrl,
    published_at: lead.publishedAt,
    author_name: lead.authorName,
    author_email: lead.authorEmail,
    first_name: lead.firstName,
    school_name: lead.schoolName,
    school_tier: lead.schoolTier,
    compute_level: lead.computeLevel,
    compute_confidence: lead.computeConfidence,
    compute_reason: lead.computeReason,
    matched_directions: lead.matchedDirections,
    draft_subject: draft?.subject ?? null,
    draft_html: draft?.html ?? null,
    status: draft ? "ready" : "new",
    s2_author_id: extras.s2AuthorId ?? null,
    h_index: extras.hIndex ?? null,
    citation_count: extras.citationCount ?? null,
    paper_count: extras.paperCount ?? null,
    lead_tier: extras.leadTier ?? "normal",
    assigned_rep_id: extras.assignedRepId ?? null,
  });
}

export async function POST(req: NextRequest) {
  const isVercelCron =
    req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const referer = req.headers.get("referer") || "";
  const host = req.headers.get("host") || "__none__";
  const isInternal = referer.includes(host);

  if (process.env.CRON_SECRET && !isVercelCron && !isInternal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { leads, stats } = await scanArxiv();
    const config = await getAssignmentConfig();
    let leadsCreated = 0;

    for (const lead of leads) {
      // 1. Semantic Scholar enrichment
      let s2: { authorId: string; hIndex: number | null; citationCount: number | null; paperCount: number | null } | null = null;
      try {
        s2 = await lookupAuthor(lead.title, lead.authorName);
      } catch {
        // S2 enrichment is best-effort
      }

      // 2. Classify and assign
      const hIndex = s2?.hIndex ?? null;
      const tier = classifyLead(config, {
        hIndex,
        schoolTier: lead.schoolTier,
        authorEmail: lead.authorEmail,
      });
      const repId = assignRep(config, tier);

      // 3. Get rep info for draft generation
      const rep = await getRep(repId);

      // 4. Generate draft with rep identity
      let draft: { subject: string; html: string } | null = null;
      try {
        draft = await generateDraft({
          title: lead.title,
          abstract: lead.abstract,
          authorEmail: lead.authorEmail,
          firstName: lead.firstName,
          schoolName: lead.schoolName,
          schoolTier: lead.schoolTier,
          matchedDirections: lead.matchedDirections,
          repName: rep?.name ?? undefined,
          repWechatId: rep?.wechat_id ?? undefined,
        });
      } catch {
        // Draft generation failed — insert with status 'new'
      }

      // 5. Insert with enrichment data
      const { error } = await insertLead(lead, draft, {
        s2AuthorId: s2?.authorId ?? null,
        hIndex: s2?.hIndex ?? null,
        citationCount: s2?.citationCount ?? null,
        paperCount: s2?.paperCount ?? null,
        leadTier: tier,
        assignedRepId: repId,
      });
      if (!error) leadsCreated++;
    }

    return NextResponse.json({ stats, leadsCreated });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Pipeline scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Update GET handler to return new fields and support filters**

In the GET handler, add `tier` and `rep_id` filter support, and map new fields:

```ts
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");
  const tier = searchParams.get("tier");
  const repId = searchParams.get("rep_id");
  const offset = (page - 1) * limit;

  let query = supabase
    .from("pipeline_leads")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  let countQuery = supabase
    .from("pipeline_leads")
    .select("*", { count: "exact", head: true });

  if (status) {
    query = query.eq("status", status);
    countQuery = countQuery.eq("status", status);
  }
  if (tier) {
    query = query.eq("lead_tier", tier);
    countQuery = countQuery.eq("lead_tier", tier);
  }
  if (repId) {
    query = query.eq("assigned_rep_id", parseInt(repId));
    countQuery = countQuery.eq("assigned_rep_id", parseInt(repId));
  }

  const [{ data: leads }, { count: total }] = await Promise.all([
    query,
    countQuery,
  ]);

  const mapped = (leads || []).map((l) => ({
    id: l.id,
    arxivId: l.arxiv_id,
    title: l.title,
    abstract: l.abstract,
    authors: l.authors,
    pdfUrl: l.pdf_url,
    publishedAt: l.published_at,
    authorName: l.author_name,
    authorEmail: l.author_email,
    firstName: l.first_name,
    schoolName: l.school_name,
    schoolTier: l.school_tier,
    computeLevel: l.compute_level,
    computeConfidence: l.compute_confidence,
    computeReason: l.compute_reason,
    matchedDirections: l.matched_directions,
    draftSubject: l.draft_subject,
    draftHtml: l.draft_html,
    status: l.status,
    sentAt: l.sent_at,
    createdAt: l.created_at,
    // New fields
    s2AuthorId: l.s2_author_id,
    hIndex: l.h_index,
    citationCount: l.citation_count,
    paperCount: l.paper_count,
    leadTier: l.lead_tier,
    assignedRepId: l.assigned_rep_id,
  }));

  return NextResponse.json({ leads: mapped, total: total || 0, page, limit });
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/scanner.ts src/app/api/pipeline/route.ts
git commit -m "feat: wire S2 enrichment + lead assignment into scan pipeline"
```

---

## Task 5: Update Email Generator for Rep Identity

**Files:**
- Modify: `src/lib/email-generator.ts`

- [ ] **Step 1: Add rep params to generateDraft**

Change the `generateDraft` function signature and body to accept optional rep identity:

```ts
export async function generateDraft(lead: {
  title: string;
  abstract: string;
  authorEmail: string;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  matchedDirections: string[];
  repName?: string;
  repWechatId?: string;
}): Promise<{ subject: string; html: string }> {
```

Then replace the hardcoded `Lorenserus1` and `Leo` with the rep params:

- Change the closing name and WeChat link:

```ts
  const repName = lead.repName ?? "Leo";
  const repWechat = lead.repWechatId ?? "Lorenserus1";
```

- In the `html` template, replace the hardcoded WeChat ID and signature:

Change:
```
如果${closingName}对算力支持感兴趣，欢迎<a href="${APPLY_URL_CTA}">申请</a>或加我微信交流（Lorenserus1）。
```
To:
```
如果${closingName}对算力支持感兴趣，欢迎<a href="${APPLY_URL_CTA}">申请</a>或加我微信交流（${escapeHtml(repWechat)}）。
```

Change the signature from hardcoded `Leo<br>奇绩创坛` to:
```
<span style="font-size: 14px; color: #333; line-height: 1.6;">${escapeHtml(repName)}<br>奇绩创坛</span>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/email-generator.ts
git commit -m "feat: email draft uses assigned rep's name and wechat"
```

---

## Task 6: Update Send Routes for Per-Rep Identity

**Files:**
- Modify: `src/app/api/pipeline/send/route.ts`
- Modify: `src/app/api/pipeline/batch-send/route.ts`
- Modify: `src/app/api/pipeline/[id]/route.ts`

- [ ] **Step 1: Update single send route**

In `send/route.ts`, replace the hardcoded sender with rep lookup:

```ts
import { getRep } from "@/lib/assignment";

// ... inside POST handler, after fetching the lead:

    // Look up assigned rep (fall back to env vars)
    let senderFrom = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
    if (lead.assigned_rep_id) {
      const rep = await getRep(lead.assigned_rep_id);
      if (rep) {
        senderFrom = `${rep.sender_name} <${rep.sender_email}>`;
      }
    }
```

- [ ] **Step 2: Update batch send route**

Same change in `batch-send/route.ts` — inside the for loop, after fetching each lead:

```ts
import { getRep } from "@/lib/assignment";

// ... inside the for loop, replace the hardcoded senderFrom:

      let senderFrom = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
      if (lead.assigned_rep_id) {
        const rep = await getRep(lead.assigned_rep_id);
        if (rep) {
          senderFrom = `${rep.sender_name} <${rep.sender_email}>`;
        }
      }
```

Remove the hardcoded `senderFrom` line at the top of the handler.

- [ ] **Step 3: Update PATCH route to support assigned_rep_id**

In `[id]/route.ts`, add `assigned_rep_id` and `lead_tier` to the PATCH handler:

```ts
    const { status, draftSubject, draftHtml, assignedRepId, leadTier } = body;

    const updates: Record<string, unknown> = {};
    if (status !== undefined) updates.status = status;
    if (draftSubject !== undefined) updates.draft_subject = draftSubject;
    if (draftHtml !== undefined) updates.draft_html = draftHtml;
    if (assignedRepId !== undefined) updates.assigned_rep_id = assignedRepId;
    if (leadTier !== undefined) updates.lead_tier = leadTier;
```

Also update the `mapLead` function to include new fields:

```ts
    // Add to mapLead return:
    s2AuthorId: l.s2_author_id,
    hIndex: l.h_index,
    citationCount: l.citation_count,
    paperCount: l.paper_count,
    leadTier: l.lead_tier,
    assignedRepId: l.assigned_rep_id,
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/pipeline/send/route.ts src/app/api/pipeline/batch-send/route.ts src/app/api/pipeline/\\[id\\]/route.ts
git commit -m "feat: send routes use per-lead rep identity"
```

---

## Task 7: Sales Reps API

**Files:**
- Create: `src/app/api/sales-reps/route.ts`

- [ ] **Step 1: Create CRUD endpoint**

```ts
// src/app/api/sales-reps/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  const { data, error } = await supabase
    .from("sales_reps")
    .select("*")
    .order("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ reps: data });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { id, name, sender_email, sender_name, wechat_id, active } = body;

  if (!name || !sender_email || !sender_name || !wechat_id) {
    return NextResponse.json(
      { error: "name, sender_email, sender_name, wechat_id are required" },
      { status: 400 },
    );
  }

  if (id) {
    // Update existing
    const { data, error } = await supabase
      .from("sales_reps")
      .update({ name, sender_email, sender_name, wechat_id, active: active ?? true })
      .eq("id", id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ rep: data });
  }

  // Create new
  const { data, error } = await supabase
    .from("sales_reps")
    .insert({ name, sender_email, sender_name, wechat_id, active: active ?? true })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rep: data });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/sales-reps/route.ts
git commit -m "feat: add sales reps CRUD API"
```

---

## Task 8: Assignment Config API

**Files:**
- Create: `src/app/api/config/assignment/route.ts`

- [ ] **Step 1: Create config endpoint**

```ts
// src/app/api/config/assignment/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { getAssignmentConfig } from "@/lib/assignment";

export async function GET() {
  const config = await getAssignmentConfig();
  return NextResponse.json(config);
}

export async function PUT(req: NextRequest) {
  const body = await req.json();

  // Validate structure
  if (!body.strong_criteria || !body.assignment) {
    return NextResponse.json(
      { error: "Must include strong_criteria and assignment" },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("system_config")
    .upsert(
      {
        key: "lead_assignment",
        value: body,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, config: body });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/config/assignment/route.ts
git commit -m "feat: add assignment config GET/PUT API"
```

---

## Task 9: Analytics API

**Files:**
- Create: `src/app/api/pipeline/analytics/route.ts`

- [ ] **Step 1: Create analytics endpoint**

```ts
// src/app/api/pipeline/analytics/route.ts
import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  // Parallel queries for all analytics data
  const [
    { data: allLeads },
    { data: reps },
    { data: wechatConversions },
    { data: dailyLeads },
  ] = await Promise.all([
    // All leads with relevant fields
    supabase
      .from("pipeline_leads")
      .select("id, status, lead_tier, assigned_rep_id, h_index, source, created_at, sent_at, author_email"),

    // All reps
    supabase.from("sales_reps").select("*").order("id"),

    // WeChat conversions
    supabase
      .from("brief_lookups")
      .select("id, query, added_wechat, wechat_at, created_at")
      .eq("added_wechat", true),

    // Daily lead counts (last 30 days)
    supabase
      .from("pipeline_leads")
      .select("created_at, lead_tier")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const leads = allLeads ?? [];
  const wechat = wechatConversions ?? [];

  // ── Channel stats ──
  const totalLeads = leads.length;
  const strongLeads = leads.filter((l) => l.lead_tier === "strong").length;
  const sentLeads = leads.filter((l) => l.status === "sent" || l.status === "replied").length;
  const hIndexValues = leads.map((l) => l.h_index).filter((v): v is number => v !== null);
  const avgHIndex = hIndexValues.length > 0
    ? Math.round((hIndexValues.reduce((a, b) => a + b, 0) / hIndexValues.length) * 10) / 10
    : 0;
  const wechatCount = wechat.length;
  const conversionRate = sentLeads > 0 ? Math.round((wechatCount / sentLeads) * 1000) / 10 : 0;

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const leadsThisWeek = leads.filter((l) => l.created_at >= oneWeekAgo).length;

  // ── Daily breakdown (last 30 days) ──
  const dailyMap = new Map<string, { strong: number; normal: number }>();
  for (const l of dailyLeads ?? []) {
    const day = l.created_at.split("T")[0];
    const entry = dailyMap.get(day) ?? { strong: 0, normal: 0 };
    if (l.lead_tier === "strong") entry.strong++;
    else entry.normal++;
    dailyMap.set(day, entry);
  }

  const daily = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  // ── h-index distribution ──
  const hIndexBuckets = [0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100];
  const hIndexDist = hIndexBuckets.map((min, i) => {
    const max = hIndexBuckets[i + 1] ?? Infinity;
    const count = hIndexValues.filter((v) => v >= min && v < max).length;
    return { min, max: max === Infinity ? null : max, count };
  });

  // ── Per-rep stats ──
  const repStats = (reps ?? []).map((rep) => {
    const repLeads = leads.filter((l) => l.assigned_rep_id === rep.id);
    const assigned = repLeads.length;
    const sent = repLeads.filter((l) => l.status === "sent" || l.status === "replied").length;
    // Count replies by checking inbound emails (approximate: leads with status 'replied')
    const replied = repLeads.filter((l) => l.status === "replied").length;

    // WeChat conversions for this rep's leads
    const repEmails = new Set(repLeads.map((l) => l.author_email?.toLowerCase()));
    const repWechat = wechat.filter((w) =>
      repEmails.has(w.query?.toLowerCase()),
    ).length;

    const repConvRate = sent > 0 ? Math.round((repWechat / sent) * 1000) / 10 : 0;

    // Per-tier breakdown
    const tiers = ["strong", "normal"].map((tier) => {
      const tierLeads = repLeads.filter((l) => l.lead_tier === tier);
      const tierSent = tierLeads.filter((l) => l.status === "sent" || l.status === "replied").length;
      const tierReplied = tierLeads.filter((l) => l.status === "replied").length;
      const tierEmails = new Set(tierLeads.map((l) => l.author_email?.toLowerCase()));
      const tierWechat = wechat.filter((w) => tierEmails.has(w.query?.toLowerCase())).length;
      return {
        tier,
        assigned: tierLeads.length,
        sent: tierSent,
        replied: tierReplied,
        wechat: tierWechat,
        convRate: tierSent > 0 ? Math.round((tierWechat / tierSent) * 1000) / 10 : 0,
      };
    });

    return {
      rep: { id: rep.id, name: rep.name, sender_email: rep.sender_email, wechat_id: rep.wechat_id },
      assigned,
      sent,
      replied,
      wechat: repWechat,
      convRate: repConvRate,
      tiers,
    };
  });

  return NextResponse.json({
    channels: {
      totalLeads,
      strongLeads,
      leadsThisWeek,
      avgHIndex,
      sentLeads,
      wechatCount,
      conversionRate,
      daily,
      hIndexDist,
      sources: [
        {
          source: "arXiv",
          total: totalLeads,
          strong: strongLeads,
          normal: totalLeads - strongLeads,
          sent: sentLeads,
          wechat: wechatCount,
          convRate: conversionRate,
        },
      ],
    },
    sales: { reps: repStats },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/pipeline/analytics/route.ts
git commit -m "feat: add pipeline analytics API for channels and sales tabs"
```

---

## Task 10: Pipeline Page — Three Tabs with Batch Workflow

**Files:**
- Modify: `src/app/pipeline/page.tsx` — major rewrite with tabs, new fields, batch banner

This is the largest task. The pipeline page needs:
1. Tab switcher (Leads, Channels, Sales)
2. Leads tab: batch banner, tier badges, h-index pills, rep dropdown, tier/rep filters
3. Channels tab: stat cards, daily chart, source table, h-index histogram, assignment config
4. Sales tab: rep cards, performance matrix, rep management

- [ ] **Step 1: Rewrite pipeline page**

This is a full rewrite of `src/app/pipeline/page.tsx`. The new page imports Recharts for charts, fetches analytics data for Channels/Sales tabs, and adds the batch review workflow.

Key changes from current code:
- Add `Lead` interface fields: `hIndex`, `citationCount`, `leadTier`, `assignedRepId`, `s2AuthorId`, `paperCount`
- Add state for `activeTab` ("leads" | "channels" | "sales")
- Add state for `reps` (fetched from `/api/sales-reps`)
- Add state for `analytics` (fetched from `/api/pipeline/analytics`)
- Add state for `assignmentConfig` (fetched from `/api/config/assignment`)
- Leads tab: show tier badge, h-index pill, citation pill, rep dropdown per lead
- Add tier and rep filter selects
- Batch banner at top of Leads tab showing today's ready count
- Channels tab: stat cards + Recharts BarChart + source table + h-index histogram + assignment rules form
- Sales tab: rep summary cards + performance matrix table + rep management table

The full implementation code is too large for inline plan — the implementer should:
1. Start with the current `pipeline/page.tsx`
2. Add the tab system (3 tab buttons at top, conditional rendering below)
3. Add new Lead interface fields and update the fetch/map
4. Add rep dropdown and tier badge to each lead card
5. Add tier/rep filter selects in the filter bar
6. Add batch banner component above lead list
7. Build Channels tab as a new component section
8. Build Sales tab as a new component section
9. Wire up the analytics and config API calls

Reference the mockup at `public/mockup-pipeline-v2.html` for exact layout structure, CSS classes, and data display format.

- [ ] **Step 2: Verify all tabs render**

Open `http://localhost:3333/pipeline` and click through all 3 tabs. Verify:
- Leads tab shows tier badges, h-index, rep dropdown
- Channels tab shows stat cards and chart
- Sales tab shows rep cards and performance table

- [ ] **Step 3: Commit**

```bash
git add src/app/pipeline/page.tsx
git commit -m "feat: pipeline page with 3 tabs — leads, channels, sales"
```

---

## Task Summary

| Task | Description | Depends On |
|------|------------|------------|
| 1 | DB migration (tables + columns) | — |
| 2 | Semantic Scholar client | — |
| 3 | Assignment engine | — |
| 4 | Wire S2 + assignment into scanner | 1, 2, 3 |
| 5 | Email generator rep identity | — |
| 6 | Send routes per-rep identity | 1, 3, 5 |
| 7 | Sales reps CRUD API | 1 |
| 8 | Assignment config API | 1, 3 |
| 9 | Analytics API | 1 |
| 10 | Pipeline page 3 tabs | 4, 7, 8, 9 |

Tasks 1-3 and 5 can run in parallel. Tasks 7-9 can run in parallel after Task 1. Task 10 depends on all API tasks being complete.
