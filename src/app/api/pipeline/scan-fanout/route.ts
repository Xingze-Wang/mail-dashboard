import { NextRequest, NextResponse } from "next/server";

/**
 * /api/pipeline/scan-fanout — sharded scan orchestrator.
 *
 * Why this exists: `/api/pipeline/scan` is serial-within-tick (the inner
 * loop processes papers one at a time, ~32s per analyzed paper), so a
 * single 300s function can only get through ~7 leads. To match Python's
 * burst throughput inside Vercel's per-function timeout, we fan out to N
 * child invocations in parallel — each is its own function with its own
 * 300s budget. Wall-clock stays bounded by the slowest child; total work
 * scales linearly with N.
 *
 * Triggered by a single cron entry in vercel.json. The orchestrator does
 * NO scan work itself — it just dispatches and aggregates.
 *
 * Auth: CRON_SECRET (same as /api/cron). Vercel sets
 * `authorization: Bearer $CRON_SECRET` on its cron-fired requests.
 *
 * Query params:
 *   total   = number of shards to fan out to (default 4, max 8)
 *   papers  = papers per shard (default 50; total work = total * papers)
 *   budgetMs = per-shard time budget in ms (default 120000, max 280000)
 *
 * Returns the combined stats from every child, including per-shard
 * latency so you can see which shards lagged.
 */

// Orchestrator itself does little work, but each child fetch can run up
// to ~280s. With `Promise.all` we wait on all children, so the parent
// must outlive the slowest child. 300s is the Pro hard cap.
export const maxDuration = 300;

const MAX_SHARDS = 8;
const DEFAULT_SHARDS = 4;
const DEFAULT_PAPERS_PER_SHARD = 50;
const DEFAULT_BUDGET_MS = 120_000;

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function resolveOrigin(): string {
  // VERCEL_URL is auto-injected on every Vercel deployment (preview + prod).
  // No protocol prefix — we add `https://`. Fallback to the canonical prod
  // domain so a misconfigured env doesn't break the fanout entirely.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://qiji-pipeline.vercel.app";
}

type ShardResult = {
  shard: number;
  ok: boolean;
  status?: number;
  durationMs: number;
  body?: unknown;
  error?: string;
};

async function callShard(
  origin: string,
  secret: string,
  shard: number,
  total: number,
  papers: number,
  budgetMs: number,
): Promise<ShardResult> {
  const t0 = Date.now();
  const url =
    `${origin}/api/pipeline/scan` +
    `?shard=${shard}&total=${total}&papers=${papers}&budgetMs=${budgetMs}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      // Don't let fetch cache anything — every shard call is fresh work.
      cache: "no-store",
    });
    const durationMs = Date.now() - t0;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    return { shard, ok: res.ok, status: res.status, durationMs, body };
  } catch (err) {
    return {
      shard,
      ok: false,
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handle(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // checkAuth would have already returned 401 in this case, but guard
    // anyway so TS knows secret is defined when we pass it to callShard.
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const total = Math.max(
    1,
    Math.min(MAX_SHARDS, Number(url.searchParams.get("total") ?? DEFAULT_SHARDS)),
  );
  const papers = Math.max(
    1,
    Math.min(500, Number(url.searchParams.get("papers") ?? DEFAULT_PAPERS_PER_SHARD)),
  );
  const budgetMs = Math.max(
    1000,
    Math.min(280_000, Number(url.searchParams.get("budgetMs") ?? DEFAULT_BUDGET_MS)),
  );

  if (!Number.isFinite(total) || !Number.isFinite(papers) || !Number.isFinite(budgetMs)) {
    return NextResponse.json({ error: "Invalid query params" }, { status: 400 });
  }

  const origin = resolveOrigin();
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      callShard(origin, secret, i, total, papers, budgetMs),
    ),
  );
  const wallMs = Date.now() - t0;

  // Aggregate. Each shard returns { stats, leadsCreated, ... }; pull the
  // counts out and sum. Errors are surfaced per-shard so you can see
  // which one timed out vs which one returned a 500.
  let leadsCreated = 0;
  let checked = 0;
  let filtered = 0;
  const errors: string[] = [];
  for (const r of results) {
    if (!r.ok) {
      errors.push(`shard ${r.shard} failed: status=${r.status} err=${r.error ?? ""}`);
      continue;
    }
    const body = r.body as
      | {
          leadsCreated?: number;
          stats?: { checked?: number; filtered?: number; errors?: string[] };
        }
      | undefined;
    leadsCreated += body?.leadsCreated ?? 0;
    checked += body?.stats?.checked ?? 0;
    filtered += body?.stats?.filtered ?? 0;
    for (const e of body?.stats?.errors ?? []) {
      errors.push(`shard ${r.shard}: ${e}`);
    }
  }

  return NextResponse.json({
    leadsCreated,
    checked,
    filtered,
    errors,
    wallMs,
    shards: results.map((r) => ({
      shard: r.shard,
      ok: r.ok,
      status: r.status,
      durationMs: r.durationMs,
      leadsCreated: (r.body as { leadsCreated?: number } | undefined)?.leadsCreated,
    })),
    config: { total, papers, budgetMs },
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
