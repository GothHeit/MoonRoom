import type { Tokens } from "@app/api-client";

export const ACCESS_COOKIE = "mr_access";
export const REFRESH_COOKIE = "mr_refresh";

/** Marks this browser as trusted for two-factor login; it outlives sign-out on purpose. */
export const TRUSTED_COOKIE = "mr_trusted";
const TRUSTED_MAX_AGE = 60 * 60 * 24 * 30;

const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

type CookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

function base(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export type CookieSpec = { name: string; value: string; options: CookieOptions };

/** The access cookie expires a little before the token so it is refreshed before it fails. */
export function sessionCookies(tokens: Tokens): CookieSpec[] {
  return [
    { name: ACCESS_COOKIE, value: tokens.access_token, options: base(Math.max(tokens.expires_in - 30, 1)) },
    { name: REFRESH_COOKIE, value: tokens.refresh_token, options: base(REFRESH_MAX_AGE) },
  ];
}

export function trustedCookie(token: string): CookieSpec {
  return { name: TRUSTED_COOKIE, value: token, options: base(TRUSTED_MAX_AGE) };
}

export function clearedCookies(): CookieSpec[] {
  return [ACCESS_COOKIE, REFRESH_COOKIE].map((name) => ({ name, value: "", options: base(0) }));
}

type CookieSetter = { set(name: string, value: string, options: CookieOptions): unknown };

export function applyCookies(target: CookieSetter, cookies: CookieSpec[]) {
  for (const c of cookies) target.set(c.name, c.value, c.options);
}
