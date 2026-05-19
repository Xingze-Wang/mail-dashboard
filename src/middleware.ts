import { NextRequest, NextResponse } from "next/server";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/cron",
  // Congress cron routes — each handler does its own Bearer-CRON_SECRET
  // check, same pattern as /api/cron. Without this, middleware 401s
  // them before they can validate.
  "/api/congress",
  // Mission cron entry points — both handlers gate themselves with
  // Bearer + x-vercel-cron. Listing the specific subpaths (not
  // `/api/missions` blanket) so the rep-facing /api/missions GET still
  // needs a session. Bug discovered 2026-05-19: route auth was fixed
  // in 9840e77 but middleware blocked first, so allocator + seeder had
  // been silently 401'd since 2026-05-14. Match by exact path prefix.
  "/api/missions/allocate-leads",
  "/api/missions/heuristic-seed",
  // Webhook diagnostic — no PII, returns "have we ever received an
  // event" so admins can verify Resend → us plumbing externally
  // (e.g. from Resend dashboard, no cookie). Tier 0 visibility tool.
  "/api/webhook/health",
  "/_next",
  "/favicon",
];

// /api/inbound is split: POST (Resend webhook) is public — protected by its
// own INBOUND_SECRET bearer check inside the handler. GET (used by /inbox UI)
// requires a session.
//
// /api/webhook is the OTHER Resend webhook (the canonical event stream:
// email.sent / delivered / opened / clicked / bounced / complained). The
// handler validates Svix signatures internally via RESEND_WEBHOOK_SECRET.
// This is the Tier 0 fix from docs/DATA_INTEGRITY_PLAN.md — without
// allowlisting it, middleware 401s every Resend POST and webhook_events
// stays empty (which is exactly the state we observed for ~30 days).
//
// /api/lark/webhook is fully public — Lark's URL-verification handshake
// hits both GET and POST without auth, and message events are signed via
// LARK_VERIFICATION_TOKEN which the handler validates internally. Without
// this, Lark cannot register the webhook URL.
const PUBLIC_POST_ONLY = ["/api/inbound", "/api/webhook"];
const PUBLIC_LARK_WEBHOOK = "/api/lark/webhook";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-pathname", pathname);

  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || pathname.includes(".");
  const isPublicPostOnly =
    req.method === "POST" && PUBLIC_POST_ONLY.some((p) => pathname.startsWith(p));
  const isLarkWebhook = pathname === PUBLIC_LARK_WEBHOOK;
  if (isPublic || isPublicPostOnly || isLarkWebhook) {
    return NextResponse.next({ request: { headers: reqHeaders } });
  }

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  console.log("[middleware] path:", pathname, "has_token:", !!token, "auth_secret_set:", !!process.env.AUTH_SECRET);
  const session = await verifySession(token);
  console.log("[middleware] session:", session ? `repId=${session.repId}` : "null");
  if (session) {
    reqHeaders.set("x-rep-id", String(session.repId));
    // HTTP/1.1 headers are Latin-1 (RFC 7230). Chinese rep names contain
    // chars > U+00FF and would throw `TypeError: Cannot convert argument
    // to a ByteString` at this Headers.set call, taking down every
    // authed API for that rep. encodeURIComponent percent-encodes to
    // ASCII, which is header-safe; readers must decodeURIComponent.
    reqHeaders.set("x-rep-name", encodeURIComponent(session.repName));
    reqHeaders.set("x-rep-email", session.email);
    // NOTE: x-rep-role from the JWT may be stale (30-day cookie). Handlers
    // MUST NOT trust this header for authorization — use requireSession(),
    // which re-reads the current role from sales_reps on every call.
    reqHeaders.set("x-rep-role", session.role);
    return NextResponse.next({ request: { headers: reqHeaders } });
  }

  // Machine-to-machine routes: Python scraper hits /api/pipeline/import and
  // /api/pipeline/record with `Authorization: Bearer $PIPELINE_IMPORT_KEY`.
  if (
    (pathname === "/api/pipeline/import" || pathname === "/api/pipeline/record") &&
    process.env.PIPELINE_IMPORT_KEY &&
    req.headers.get("authorization") === `Bearer ${process.env.PIPELINE_IMPORT_KEY}`
  ) {
    return NextResponse.next({ request: { headers: reqHeaders } });
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
