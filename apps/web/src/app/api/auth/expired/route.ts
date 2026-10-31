import { NextResponse } from "next/server";

import { applyCookies, clearedCookies } from "@/lib/cookies";
import { routing } from "@/i18n/routing";

/**
 * Where a server component sends the user when the API refuses their access token. The
 * cookies are dropped here first, otherwise the middleware sees a cookie, treats the user as
 * signed in and bounces /login back to the page that sent them away (a redirect loop).
 */
export function GET(request: Request) {
  // A cross-site link must not be able to sign someone out.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
  }
  const url = new URL(request.url);
  const asked = url.searchParams.get("locale");
  const locale = routing.locales.find((l) => l === asked) ?? routing.defaultLocale;
  const response = NextResponse.redirect(new URL(`/${locale}/login`, request.url));
  applyCookies(response.cookies, clearedCookies());
  return response;
}
