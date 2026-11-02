import type { Tokens } from "@app/api-client";
import { NextResponse } from "next/server";

import { API_URL } from "./config";
import { applyCookies, sessionCookies, TRUSTED_COOKIE, trustedCookie } from "./cookies";
import { FORBIDDEN_ORIGIN, isSameOrigin } from "./origin";
import { deviceHeaders } from "./session";

/**
 * Forwards a sign-in or register call to the API and stores the tokens in httpOnly cookies.
 * With two-factor login the password step answers 200 with a short-lived challenge token (kept
 * in page memory, never a cookie); the code step then answers with the tokens. A browser the user
 * trusted sends its cookie along with the password step so the code is skipped.
 */
export async function tokenRoute(apiPath: string, request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json(FORBIDDEN_ORIGIN, { status: 403 });
  // Only JSON: a cross-site HTML form cannot send it, which blocks login CSRF.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: { code: "validation_failed", message: "Expected JSON" } }, { status: 415 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}${apiPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceHeaders(request.headers) },
      body: withTrustedDevice(apiPath, await request.text(), request),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: { code: "network", message: "API unreachable" } }, { status: 502 });
  }
  if (!upstream.ok) {
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const data = (await upstream.json()) as Tokens & { mfa_required?: boolean; mfa_token?: string; trusted_device?: string | null };
  if (data.mfa_required) return NextResponse.json({ mfa_required: true, mfa_token: data.mfa_token });
  const response = new NextResponse(null, { status: 204 });
  applyCookies(response.cookies, sessionCookies(data));
  if (data.trusted_device) applyCookies(response.cookies, [trustedCookie(data.trusted_device)]);
  return response;
}

function withTrustedDevice(apiPath: string, body: string, request: Request): string {
  if (apiPath !== "/auth/login") return body;
  const match = new RegExp(`(?:^|;\\s*)${TRUSTED_COOKIE}=([^;]+)`).exec(request.headers.get("cookie") ?? "");
  const trusted = match?.[1];
  if (!trusted) return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, trusted_device: trusted });
  } catch {
    return body;
  }
}
