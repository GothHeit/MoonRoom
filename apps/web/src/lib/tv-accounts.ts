import type { Tokens } from "@app/api-client";
import { NextResponse } from "next/server";

import type { AvatarInfo } from "./avatar";
import { API_URL } from "./config";
import {
  accountsCookie,
  applyCookies,
  clearedAccountsCookie,
  clearedCookies,
  REFRESH_COOKIE,
  sessionCookies,
  type CookieSpec,
} from "./cookies";
import { FORBIDDEN_ORIGIN, isSameOrigin } from "./origin";
import { deviceHeaders, refreshSession } from "./session";

// Several accounts on one TV. The signed-in account keeps the usual mr_access/mr_refresh cookies;
// every other account on the TV is "parked" in one httpOnly cookie, mr_accounts, with the refresh
// token of its session. Switching swaps a parked account in, and parks the one that was active.
//
// A refresh token is rotated every time it is used, and the API treats a second use of a spent one
// as theft. So an account is only ever parked with the token its last refresh handed out (never
// a copy taken earlier), and a parked token is not touched until its owner is picked again.

/** The most accounts one TV holds, the active one included. */
export const MAX_ACCOUNTS = 5;

/** What the picker shows about an account. Never carries a token. */
export type TvAccount = { id: string; name: string; avatar: AvatarInfo };
export type ParkedAccount = TvAccount & { refresh: string };

const NAME_MAX = 32;
// A cookie holds about 4 KB. Five accounts stay well under it; this is only a backstop.
const COOKIE_BUDGET = 3500;

function shapeOk(a: unknown): a is ParkedAccount {
  if (typeof a !== "object" || a === null) return false;
  const v = a as Record<string, unknown>;
  const avatar = v.avatar as Record<string, unknown> | null | undefined;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.refresh === "string" &&
    v.refresh.length > 0 &&
    typeof avatar === "object" &&
    avatar !== null &&
    typeof avatar.kind === "string"
  );
}

/** The parked accounts in a cookie value. Anything malformed is dropped, never trusted. */
export function parseParked(raw: string | undefined | null): ParkedAccount[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const result: ParkedAccount[] = [];
    for (const item of list) {
      if (!shapeOk(item) || seen.has(item.id)) continue;
      seen.add(item.id);
      result.push({ id: item.id, name: item.name.slice(0, NAME_MAX), avatar: item.avatar, refresh: item.refresh });
    }
    return result.slice(0, MAX_ACCOUNTS - 1);
  } catch {
    return [];
  }
}

function encode(list: ParkedAccount[]): string {
  let value = Buffer.from(JSON.stringify(list), "utf8").toString("base64url");
  if (value.length > COOKIE_BUDGET) {
    // Long picture addresses are the only thing that can swell it: show initials instead.
    const slim = list.map((a) => (a.avatar.kind === "mal" ? { ...a, avatar: { kind: "none" as const, version: 0 } } : a));
    value = Buffer.from(JSON.stringify(slim), "utf8").toString("base64url");
  }
  return value;
}

/** The cookie that stores `list`, or one that removes the cookie when nobody is parked. */
export function parkedCookie(list: ParkedAccount[]): CookieSpec {
  return list.length > 0 ? accountsCookie(encode(list)) : clearedAccountsCookie();
}

export function publicAccount({ id, name, avatar }: ParkedAccount): TvAccount {
  return { id, name, avatar };
}

/** The picker lists accounts by name, so the order never jumps around when one is picked. */
export function sortAccounts<T extends TvAccount>(list: T[]): T[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

function readCookie(request: Request, name: string): string | undefined {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(request.headers.get("cookie") ?? "");
  return match ? decodeURIComponent(match[1]) : undefined;
}

function parkedFrom(request: Request): ParkedAccount[] {
  return parseParked(readCookie(request, "mr_accounts"));
}

async function identify(access: string): Promise<TvAccount | null> {
  try {
    // Open to a locked session too, so a TV that is waiting for a PIN can still be listed.
    const res = await fetch(`${API_URL}/auth/pin`, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
    if (!res.ok) return null;
    const me = (await res.json()) as { id: string; username: string; avatar: AvatarInfo };
    return { id: me.id, name: me.username.slice(0, NAME_MAX), avatar: me.avatar };
  } catch {
    return null;
  }
}

async function apiPost(path: string, access: string | null, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return null;
  }
}

/** Ends a session on the API (best effort: a dead one is already gone). */
async function revoke(refresh: string) {
  await apiPost("/auth/logout", null, { refresh_token: refresh });
}

const NETWORK = { error: { code: "network", message: "API unreachable" } };
const EXPIRED = { error: { code: "account_expired", message: "Sign in again" } };

function error(status: number, code: string) {
  return NextResponse.json({ error: { code, message: code } }, { status });
}

function respond(status: number, cookies: CookieSpec[], body?: unknown): NextResponse {
  const res = body === undefined ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  applyCookies(res.cookies, cookies);
  return res;
}

/** What the TV's cookies say right now. */
function current(request: Request) {
  return { active: readCookie(request, REFRESH_COOKIE), parked: parkedFrom(request) };
}

/**
 * Moves the active session on: refreshes it and works out whose it is, ready to be parked with
 * its newest token. "gone": the API refused it (its cookies should go). "down": the API can't be
 * reached, so nothing should change.
 */
async function renewActive(request: Request, refresh: string | undefined) {
  if (!refresh) return { kind: "none" as const };
  const tokens = await refreshSession(refresh, deviceHeaders(request.headers));
  if (tokens === "rejected") return { kind: "gone" as const };
  if (tokens === "unavailable") return { kind: "down" as const };
  const who = await identify(tokens.access_token);
  // The refresh already spent the old token, so the new one has to be saved even if we can't park it.
  if (!who) return { kind: "down" as const, tokens };
  return { kind: "ok" as const, tokens, parked: { ...who, refresh: tokens.refresh_token } satisfies ParkedAccount };
}

/**
 * Picks an account: the parked one with this id is swapped in and the active one parked. Picking
 * the active account just renews and locks it. Either way the PIN lock is put back, so the
 * account asks for its own PIN (when it has one) before showing anything.
 */
export async function switchAccount(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json(FORBIDDEN_ORIGIN, { status: 403 });
  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (typeof id !== "string") return error(400, "validation_failed");
  const { active, parked } = current(request);
  const target = parked.find((a) => a.id === id);

  if (!target) {
    // The active account (an id that is not on this TV comes to the same thing, and is refused).
    if (!active) return error(404, "account_not_found");
    const tokens = await refreshSession(active, deviceHeaders(request.headers));
    if (tokens === "rejected") return respond(410, clearedCookies(), EXPIRED);
    if (tokens === "unavailable") return respond(502, [], NETWORK);
    const cookies = sessionCookies(tokens);
    const who = await identify(tokens.access_token);
    if (!who) return respond(502, cookies, NETWORK);
    if (who.id !== id) return respond(404, cookies, { error: { code: "account_not_found", message: "account_not_found" } });
    return (await lock(tokens)) ? respond(204, cookies) : respond(502, cookies, NETWORK);
  }

  // 1. Renew the active session first and keep its newest token: that is what gets parked.
  const old = await renewActive(request, active);
  const stay = old.kind === "gone" ? clearedCookies() : "tokens" in old && old.tokens ? sessionCookies(old.tokens) : [];
  if (old.kind === "down") return respond(502, stay, NETWORK);
  const others = parked.filter((a) => a.id !== target.id);
  const withOld = old.kind === "ok" ? [...others, old.parked] : others;

  // 2. Wake the chosen account. If it can't be woken, the TV stays on the account it was on
  // (which is then not parked: it is still the active one).
  const woken = await refreshSession(target.refresh, deviceHeaders(request.headers));
  if (woken === "rejected") return respond(410, [...stay, parkedCookie(others)], EXPIRED);
  if (woken === "unavailable") return respond(502, [...stay, parkedCookie([...others, target])], NETWORK);

  // 3. Lock it, so its own PIN is asked now.
  if (!(await lock(woken))) {
    return respond(502, [...stay, parkedCookie([...others, { ...target, refresh: woken.refresh_token }])], NETWORK);
  }
  return respond(204, [...sessionCookies(woken), parkedCookie(withOld)]);
}

async function lock(tokens: Tokens): Promise<boolean> {
  const res = await apiPost("/auth/pin/lock", tokens.access_token);
  return !!res && res.ok;
}

/** Signs an account out of the TV for good: its session is revoked, not just forgotten. */
export async function removeAccount(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json(FORBIDDEN_ORIGIN, { status: 403 });
  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (typeof id !== "string") return error(400, "validation_failed");
  const { active, parked } = current(request);
  const target = parked.find((a) => a.id === id);
  if (target) {
    await revoke(target.refresh);
    return respond(204, [parkedCookie(parked.filter((a) => a.id !== id))]);
  }
  if (!active) return error(404, "account_not_found");
  const tokens = await refreshSession(active, deviceHeaders(request.headers));
  if (tokens === "unavailable") return respond(502, [], NETWORK);
  if (tokens !== "rejected") {
    const who = await identify(tokens.access_token);
    if (!who) return respond(502, sessionCookies(tokens), NETWORK);
    if (who.id !== id) return respond(404, sessionCookies(tokens), { error: { code: "account_not_found", message: "account_not_found" } });
    await revoke(tokens.refresh_token);
  }
  return respond(204, clearedCookies());
}

/** True when this TV already holds the most accounts it can. */
export function isFull(request: Request): boolean {
  const { active, parked } = current(request);
  return parked.length + (active ? 1 : 0) >= MAX_ACCOUNTS;
}

/**
 * Called when a phone approved a code that was asked for in "add an account" mode: the new
 * session becomes the active one and the previous active account is parked. If the new
 * session belongs to an account that is already on the TV, the older session of it is
 * revoked and replaced.
 */
export async function addApproved(request: Request, tokens: Tokens): Promise<CookieSpec[]> {
  const { active, parked } = current(request);
  const who = await identify(tokens.access_token);
  const old = await renewActive(request, active);
  let list = old.kind === "ok" ? [...parked, old.parked] : parked;
  if (who) {
    // The same person added again: one session of them is enough.
    await Promise.all(list.filter((a) => a.id === who.id).map((a) => revoke(a.refresh)));
    list = list.filter((a) => a.id !== who.id);
  }
  return [...sessionCookies(tokens), parkedCookie(list.slice(0, MAX_ACCOUNTS - 1))];
}
