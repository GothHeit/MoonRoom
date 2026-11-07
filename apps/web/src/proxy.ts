import createIntlMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";

import { routing } from "./i18n/routing";
import {
  ACCESS_COOKIE,
  ACCOUNTS_COOKIE,
  applyCookies,
  clearedCookies,
  REFRESH_COOKIE,
  sessionCookies,
  type CookieSpec,
} from "./lib/cookies";
import { deviceHeaders, refreshSession } from "./lib/session";

const intl = createIntlMiddleware(routing);

const PUBLIC_PATHS = ["/login", "/register", "/tv/login"];

/** The TV mode (/tv) has its own sign-in screen: a code approved on a phone. */
const isTv = (path: string) => path === "/tv" || path.startsWith("/tv/");

/** The account picker and the "add an account" screen: open to a TV with any account on it. */
const isPicker = (path: string) => path === "/tv/accounts" || path.startsWith("/tv/accounts/");

function splitLocale(pathname: string) {
  const [, first, ...rest] = pathname.split("/");
  const locale = routing.locales.find((l) => l === first);
  return locale ? { locale, path: `/${rest.join("/")}` } : null;
}

function redirect(request: NextRequest, to: string, cookies: CookieSpec[], next?: string) {
  const url = new URL(to, request.url);
  if (next) url.searchParams.set("next", next);
  const response = NextResponse.redirect(url);
  applyCookies(response.cookies, cookies);
  return response;
}

export default async function proxy(request: NextRequest) {
  const first = intl(request);
  // Locale redirects (`/` to `/pt`) come first; auth is checked on the redirected request.
  if (first.headers.has("location")) return first;

  const parsed = splitLocale(request.nextUrl.pathname);
  if (!parsed) return first;
  const { locale, path } = parsed;
  const isPublic = PUBLIC_PATHS.includes(path);

  let signedIn = request.cookies.has(ACCESS_COOKIE);
  let renewed: NextRequest | null = null;
  let cookies: CookieSpec[] = [];

  // The access cookie expires early. Renew it here so server components always see a valid one.
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!signedIn && refresh) {
    const tokens = await refreshSession(refresh, deviceHeaders(request.headers));
    if (tokens === "unavailable") {
      // The API is down, not the session: keep the cookies and let the page's own fetch fail.
      return first;
    }
    if (tokens !== "rejected") {
      signedIn = true;
      cookies = sessionCookies(tokens);
      const headers = new Headers(request.headers);
      headers.set("cookie", `${ACCESS_COOKIE}=${tokens.access_token}; ${REFRESH_COOKIE}=${tokens.refresh_token}`);
      renewed = new NextRequest(request, { headers });
    } else {
      cookies = clearedCookies();
    }
  }

  const hasParked = request.cookies.has(ACCOUNTS_COOKIE);
  const pickerOk = isPicker(path) && hasParked;
  if (isTv(path)) {
    // Opening the TV app (a full page load of its start address) always asks who is watching.
    if ((signedIn || hasParked) && path === "/tv" && request.headers.get("sec-fetch-mode") === "navigate") {
      return redirect(request, `/${locale}/tv/accounts`, cookies);
    }
    // No active account: a TV with others parked on it asks who is watching, else it signs in.
    if (!signedIn && !isPublic && !pickerOk) {
      return redirect(request, `/${locale}/${hasParked ? "tv/accounts" : "tv/login"}`, cookies);
    }
  }
  if (!signedIn && !isPublic && !pickerOk) {
    const { search } = request.nextUrl;
    return redirect(request, `/${locale}/login`, cookies, path === "/" ? undefined : `${path}${search}`);
  }
  if (signedIn && isPublic) return redirect(request, isTv(path) ? `/${locale}/tv` : `/${locale}`, cookies);

  const response = renewed ? intl(renewed) : first;
  applyCookies(response.cookies, cookies);
  return response;
}

export const config = {
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
