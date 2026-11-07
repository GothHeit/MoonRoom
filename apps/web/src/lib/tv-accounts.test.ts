import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addApproved, isFull, MAX_ACCOUNTS, parkedCookie, parseParked, removeAccount, switchAccount, type ParkedAccount } from "./tv-accounts";
import { resetSessionState } from "./session";

const avatar = { kind: "none" as const, version: 0 };

// A stand-in for the API: every refresh token belongs to one account and is spent when used.
function fakeApi(users: Record<string, string>) {
  const live = new Map<string, string>(); // refresh token -> user id
  const access = new Map<string, string>(); // access token -> user id
  const revoked: string[] = [];
  const locked: string[] = [];
  let n = 0;
  const state = { refuse: new Set<string>(), lockFails: false };
  const issue = (userId: string) => {
    n += 1;
    live.set(`r${n}`, userId);
    access.set(`a${n}`, userId);
    return { access_token: `a${n}`, refresh_token: `r${n}`, token_type: "bearer" as const, expires_in: 900 };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const bearer = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (path === "/auth/refresh") {
        const owner = live.get(body.refresh_token);
        if (!owner || state.refuse.has(body.refresh_token)) return new Response("{}", { status: 401 });
        live.delete(body.refresh_token);
        return Response.json(issue(owner));
      }
      if (path === "/auth/logout") {
        revoked.push(body.refresh_token);
        live.delete(body.refresh_token);
        return new Response(null, { status: 204 });
      }
      const owner = access.get(bearer);
      if (!owner) return new Response("{}", { status: 401 });
      if (path === "/auth/pin") return Response.json({ id: owner, username: users[owner], avatar, enabled: true, locked: true });
      if (path === "/auth/pin/lock") {
        if (state.lockFails) return new Response("{}", { status: 503 });
        locked.push(owner);
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return { issue, revoked, locked, state, live };
}

const USERS = { u1: "Ana", u2: "Bia", u3: "Caio", u4: "Duda", u5: "Edu", u6: "Fabi" };

function post(path: string, body: unknown, cookies: string[] = []) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json", cookie: cookies.join("; ") },
    body: JSON.stringify(body),
  });
}

/** The cookies a response sets, as a request would send them back. */
function jar(res: Response, before: Record<string, string> = {}) {
  const out = { ...before };
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (/Max-Age=0/i.test(line) || value === "") delete out[name];
    else out[name] = value;
  }
  return out;
}
const header = (cookies: Record<string, string>) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
const parkedOf = (cookies: Record<string, string>) => parseParked(decodeURIComponent(cookies.mr_accounts ?? ""));

function park(cookie: ParkedAccount[]) {
  const spec = parkedCookie(cookie);
  return `${spec.name}=${spec.value}`;
}

beforeEach(() => resetSessionState());
afterEach(() => vi.unstubAllGlobals());

describe("parked accounts cookie", () => {
  it("round-trips accounts and drops anything malformed", () => {
    const list: ParkedAccount[] = [{ id: "u1", name: "Ana", avatar, refresh: "r1" }];
    expect(parseParked(parkedCookie(list).value)).toEqual(list);
    expect(parseParked("not-base64-json")).toEqual([]);
    expect(parseParked(Buffer.from(JSON.stringify([{ id: 1 }, null, "x"])).toString("base64url"))).toEqual([]);
    expect(parseParked(undefined)).toEqual([]);
  });

  it("keeps one entry per account and never more than the TV can hold", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `u${i}`, name: `n${i}`, avatar, refresh: `r${i}` }));
    expect(parseParked(parkedCookie(many).value)).toHaveLength(MAX_ACCOUNTS - 1);
    const twice = [many[0], many[0]];
    expect(parseParked(parkedCookie(twice).value)).toHaveLength(1);
  });

  it("clears the cookie when nobody is parked", () => {
    expect(parkedCookie([]).options.maxAge).toBe(0);
  });
});

describe("switching accounts", () => {
  it("swaps in the parked account, parks the active one with its newest token, and locks the new one", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const bia = api.issue("u2");
    const cookies = { mr_refresh: ana.refresh_token, mr_accounts: parkedCookie([{ id: "u2", name: "Bia", avatar, refresh: bia.refresh_token }]).value };
    const res = await switchAccount(post("/api/tv/accounts/switch", { id: "u2" }, header(cookies)));
    expect(res.status).toBe(204);
    const after = jar(res, cookies);
    // The active account is Bia's now (her token was rotated), and Ana is parked with a token that is not the spent one.
    expect(api.live.get(after.mr_refresh)).toBe("u2");
    const parked = parkedOf(after);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ id: "u1", name: "Ana" });
    expect(parked[0].refresh).not.toBe(ana.refresh_token);
    expect(api.live.get(parked[0].refresh)).toBe("u1");
    expect(api.locked).toEqual(["u2"]);
  });

  it("can swap back and forth without losing either account", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const bia = api.issue("u2");
    let cookies: Record<string, string> = { mr_refresh: ana.refresh_token, mr_accounts: parkedCookie([{ id: "u2", name: "Bia", avatar, refresh: bia.refresh_token }]).value };
    for (const id of ["u2", "u1", "u2", "u1"]) {
      const res = await switchAccount(post("/api/tv/accounts/switch", { id }, header(cookies)));
      expect(res.status).toBe(204);
      cookies = jar(res, cookies);
      expect(api.live.get(cookies.mr_refresh)).toBe(id);
    }
  });

  it("renews and locks the active account when it is picked again", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const res = await switchAccount(post("/api/tv/accounts/switch", { id: "u1" }, [`mr_refresh=${ana.refresh_token}`]));
    expect(res.status).toBe(204);
    expect(api.locked).toEqual(["u1"]);
    expect(api.live.get(jar(res).mr_refresh)).toBe("u1");
  });

  it("refuses an id that is not on the TV", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const res = await switchAccount(post("/api/tv/accounts/switch", { id: "u9" }, [`mr_refresh=${ana.refresh_token}`]));
    expect(res.status).toBe(404);
    expect(api.locked).toEqual([]);
  });

  it("drops a parked account whose sign-in expired and stays on the current one", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const bia = api.issue("u2");
    api.live.delete(bia.refresh_token);
    const cookies = { mr_refresh: ana.refresh_token, mr_accounts: parkedCookie([{ id: "u2", name: "Bia", avatar, refresh: bia.refresh_token }]).value };
    const res = await switchAccount(post("/api/tv/accounts/switch", { id: "u2" }, header(cookies)));
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("account_expired");
    const after = jar(res, cookies);
    expect(api.live.get(after.mr_refresh)).toBe("u1");
    expect(parkedOf(after)).toEqual([]);
  });

  it("does not open an account it could not lock, and keeps its new token", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const bia = api.issue("u2");
    api.state.lockFails = true;
    const cookies = { mr_refresh: ana.refresh_token, mr_accounts: parkedCookie([{ id: "u2", name: "Bia", avatar, refresh: bia.refresh_token }]).value };
    const res = await switchAccount(post("/api/tv/accounts/switch", { id: "u2" }, header(cookies)));
    expect(res.status).toBe(502);
    const after = jar(res, cookies);
    expect(api.live.get(after.mr_refresh)).toBe("u1");
    const bia2 = parkedOf(after).find((a) => a.id === "u2");
    expect(api.live.get(bia2!.refresh)).toBe("u2");
  });

  it("refuses a cross-site request", async () => {
    const req = new Request("http://localhost:3000/api/tv/accounts/switch", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ id: "u1" }),
    });
    expect((await switchAccount(req)).status).toBe(403);
  });
});

describe("removing accounts", () => {
  it("signs a parked account out for real, not just forgets it", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const bia = api.issue("u2");
    const cookies = { mr_refresh: ana.refresh_token, mr_accounts: parkedCookie([{ id: "u2", name: "Bia", avatar, refresh: bia.refresh_token }]).value };
    const res = await removeAccount(post("/api/tv/accounts/remove", { id: "u2" }, header(cookies)));
    expect(res.status).toBe(204);
    expect(api.revoked).toEqual([bia.refresh_token]);
    expect(parkedOf(jar(res, cookies))).toEqual([]);
  });

  it("signs the active account out and clears its cookies, keeping the others parked", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const bia = api.issue("u2");
    const cookies = { mr_access: "x", mr_refresh: ana.refresh_token, mr_accounts: parkedCookie([{ id: "u2", name: "Bia", avatar, refresh: bia.refresh_token }]).value };
    const res = await removeAccount(post("/api/tv/accounts/remove", { id: "u1" }, header(cookies)));
    expect(res.status).toBe(204);
    const after = jar(res, cookies);
    expect(after.mr_refresh).toBeUndefined();
    expect(after.mr_access).toBeUndefined();
    expect(parkedOf(after)).toHaveLength(1);
    // The session that was revoked is the newest one, so nothing of Ana's stays alive.
    expect(api.revoked).toHaveLength(1);
    expect(api.live.has(api.revoked[0])).toBe(false);
  });

  it("will not sign out the active account under another account's id", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const res = await removeAccount(post("/api/tv/accounts/remove", { id: "u2" }, [`mr_refresh=${ana.refresh_token}`]));
    expect(res.status).toBe(404);
    expect(api.revoked).toEqual([]);
  });
});

describe("adding accounts", () => {
  it("is full at five accounts, active one included", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `u${i}`, name: `n${i}`, avatar, refresh: `r${i}` }));
    const withActive = post("/x", {}, ["mr_refresh=r", park(four)]);
    expect(isFull(withActive)).toBe(true);
    expect(isFull(post("/x", {}, [park(four)]))).toBe(false);
    expect(isFull(post("/x", {}, ["mr_refresh=r", park(four.slice(1))]))).toBe(false);
  });

  it("parks the active account and makes the new session the active one", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const caio = api.issue("u3");
    const cookies = await addApproved(post("/x", {}, [`mr_refresh=${ana.refresh_token}`]), caio);
    const set = new Map(cookies.map((c) => [c.name, c.value]));
    expect(set.get("mr_refresh")).toBe(caio.refresh_token);
    const parked = parseParked(set.get("mr_accounts"));
    expect(parked.map((a) => a.id)).toEqual(["u1"]);
    expect(api.live.get(parked[0].refresh)).toBe("u1");
  });

  it("replaces an account that is added a second time instead of listing it twice", async () => {
    const api = fakeApi(USERS);
    const ana = api.issue("u1");
    const bia = api.issue("u2");
    const ana2 = api.issue("u1");
    const cookies = await addApproved(post("/x", {}, [`mr_refresh=${bia.refresh_token}`, park([{ id: "u1", name: "Ana", avatar, refresh: ana.refresh_token }])]), ana2);
    const set = new Map(cookies.map((c) => [c.name, c.value]));
    expect(parseParked(set.get("mr_accounts")).map((a) => a.id)).toEqual(["u2"]);
    expect(api.revoked).toContain(ana.refresh_token);
  });
});
