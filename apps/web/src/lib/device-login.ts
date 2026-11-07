import { NextResponse } from "next/server";

import { API_URL } from "./config";
import { applyCookies, clearedDeviceCookie, DEVICE_COOKIE, deviceCookie, sessionCookies } from "./cookies";
import { FORBIDDEN_ORIGIN, isSameOrigin } from "./origin";
import { deviceHeaders } from "./session";
import { addApproved, isFull } from "./tv-accounts";

// The TV side of signing in with a code. The secret the TV polls with stays in an httpOnly
// cookie, so the page only ever sees the short code it shows; an approved poll turns into the
// usual session cookies.

const NETWORK = { error: { code: "network", message: "API unreachable" } };

async function call(path: string, request: Request, body?: unknown) {
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...deviceHeaders(request.headers) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
}

function passThrough(upstream: Response, text: string) {
  return new NextResponse(text, { status: upstream.status, headers: { "Content-Type": "application/json" } });
}

/** "Add an account" mode: the TV is already signed in, and the new session joins it. */
const adding = (request: Request) => new URL(request.url).searchParams.get("add") === "1";

const FULL = { error: { code: "too_many_accounts", message: "This TV holds as many accounts as it can" } };

export async function startDeviceLogin(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json(FORBIDDEN_ORIGIN, { status: 403 });
  if (adding(request) && isFull(request)) return NextResponse.json(FULL, { status: 409 });
  let upstream: Response;
  try {
    upstream = await call("/auth/device", request);
  } catch {
    return NextResponse.json(NETWORK, { status: 502 });
  }
  const text = await upstream.text();
  if (!upstream.ok) return passThrough(upstream, text);
  const data = JSON.parse(text) as { device_token: string; user_code: string; expires_in: number; interval: number };
  const response = NextResponse.json({ user_code: data.user_code, expires_in: data.expires_in, interval: data.interval });
  applyCookies(response.cookies, [deviceCookie(data.device_token, data.expires_in)]);
  return response;
}

/** 204 once signed in, 200 {status: "pending"} while waiting, or the API's error. */
export async function pollDeviceLogin(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json(FORBIDDEN_ORIGIN, { status: 403 });
  const match = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([^;]+)`).exec(request.headers.get("cookie") ?? "");
  const token = match?.[1];
  if (!token) {
    return NextResponse.json({ error: { code: "device_login_expired", message: "Show a new code" } }, { status: 410 });
  }
  let upstream: Response;
  try {
    upstream = await call("/auth/device/token", request, { device_token: decodeURIComponent(token) });
  } catch {
    return NextResponse.json(NETWORK, { status: 502 });
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    const response = passThrough(upstream, text);
    // Expired, used or declined: the cookie can't do anything any more.
    if (upstream.status === 410 || upstream.status === 403) applyCookies(response.cookies, [clearedDeviceCookie()]);
    return response;
  }
  const data = JSON.parse(text) as { status: "pending" | "approved"; tokens?: Parameters<typeof sessionCookies>[0] | null };
  if (data.status !== "approved" || !data.tokens) return NextResponse.json({ status: "pending" });
  const response = new NextResponse(null, { status: 204 });
  if (adding(request)) {
    if (isFull(request)) {
      // Filled up while the code was out: the new session is not kept.
      await call("/auth/logout", request, { refresh_token: data.tokens.refresh_token }).catch(() => undefined);
      const full = NextResponse.json(FULL, { status: 409 });
      applyCookies(full.cookies, [clearedDeviceCookie()]);
      return full;
    }
    applyCookies(response.cookies, [...(await addApproved(request, data.tokens)), clearedDeviceCookie()]);
    return response;
  }
  applyCookies(response.cookies, [...sessionCookies(data.tokens), clearedDeviceCookie()]);
  return response;
}
