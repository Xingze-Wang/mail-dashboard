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
  "/_next",
  "/favicon",
];

// /api/inbound is split: POST (Resend webhook) is public — protected by its
// own INBOUND_SECRET bearer check inside the handler. GET (used by /inbox UI)
// requires a session.
//
// /api/lark/webhook is fully public — Lark's URL-verification handshake
// hits both GET and POST without auth, and message events are signed via
// LARK_VERIFICATION_TOKEN which the handler validates internally. Without
// this, Lark cannot register the webhook URL.
const PUBLIC_POST_ONLY = ["/api/inbound"];
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
  const session = await verifySession(token);
  if (session) {
    reqHeaders.set("x-rep-id", String(session.repId));
    reqHeaders.set("x-rep-name", session.repName);
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
