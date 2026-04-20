import { NextRequest, NextResponse } from "next/server";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/cron",
  "/api/inbound",
  "/api/scorer",
  "/_next",
  "/favicon",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-pathname", pathname);

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next({ request: { headers: reqHeaders } });
  }
  if (pathname.includes(".")) {
    return NextResponse.next({ request: { headers: reqHeaders } });
  }

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const session = verifySession(token);
  if (session) {
    reqHeaders.set("x-rep-id", String(session.repId));
    reqHeaders.set("x-rep-name", session.repName);
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
