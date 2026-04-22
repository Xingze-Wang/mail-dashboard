import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/scorer/train
 * Body: { autoPromote?: boolean }
 *
 * Fires a repository_dispatch event on GitHub → kicks off the
 * .github/workflows/train-scorer.yml workflow. Training happens on the GH
 * runner (3-8 min typical) and the script uploads the result to
 * scorer_runs when done. Vercel function returns immediately with a link
 * to the workflow run so admin can watch progress.
 *
 * Env required:
 *   GITHUB_TOKEN   — PAT or fine-grained token with `actions:write`
 *   GITHUB_REPO    — "owner/repo" (e.g. "Xingze-Wang/mail-dashboard")
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json(
      {
        error: "Server missing GITHUB_TOKEN or GITHUB_REPO env. Set these on Vercel before training from UI.",
        setupHint: "GITHUB_REPO should be 'owner/repo'; GITHUB_TOKEN needs 'actions:write' on that repo.",
      },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const autoPromote = body.autoPromote === true;

  // repository_dispatch fires any workflow listening on event_type below.
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: "train-scorer",
      client_payload: {
        triggered_by: gate.session.email,
        auto_promote: autoPromote,
      },
    }),
  });

  if (!res.ok) {
    const msg = await res.text();
    return NextResponse.json(
      { error: `GitHub dispatch failed: ${res.status} ${msg.slice(0, 200)}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Training started. It typically takes 3-8 minutes.",
    workflowUrl: `https://github.com/${repo}/actions/workflows/train-scorer.yml`,
    autoPromote,
  });
}
