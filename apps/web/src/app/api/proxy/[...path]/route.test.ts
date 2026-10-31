import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSessionState } from "@/lib/session";

import { GET, POST } from "./route";

const tokens = { access_token: "fresh", refresh_token: "next", token_type: "bearer", expires_in: 900 };
const badToken = () => Response.json({ error: { code: "invalid_token", message: "x" } }, { status: 401 });

function request(path: string, init: { method?: string; cookie?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost:3000/api/proxy/${path}`, {
    method: init.method ?? "GET",
    headers: { host: "localhost:3000", ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
    body: init.body,
  });
}
const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) }) as never;
const call = (path: string, init?: Parameters<typeof request>[1]) =>
  (init?.method === "POST" ? POST : GET)(request(path, init), ctx(path));

beforeEach(() => resetSessionState());
afterEach(() => vi.unstubAllGlobals());

describe("API proxy", () => {
  it("refuses paths outside the allow list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("auth/login");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses cross-site writes", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await call("me", { method: "POST", cookie: "mr_access=a", body: "{}", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("sends the access cookie as a bearer token and never forwards cookies", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("me", { cookie: "mr_access=abc; mr_refresh=r" });
    expect(res.status).toBe(200);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer abc");
    expect(headers.get("cookie")).toBeNull();
  });

  it("refreshes a bad access token, retries once and sets the new cookies", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/auth/refresh")) return Response.json(tokens);
      const auth = (init?.headers as Headers).get("authorization");
      return auth === "Bearer fresh" ? Response.json({ ok: true }) : badToken();
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("me", { cookie: "mr_access=old; mr_refresh=r" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toContain("mr_access=fresh");
    expect(set).toContain("mr_refresh=next");
  });

  it("does not refresh for a 401 that is not about the access token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "mal_session_expired", message: "x" } }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("me/animelist", { cookie: "mr_access=a; mr_refresh=r" });
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the cookies when the refresh token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).endsWith("/auth/refresh") ? new Response("{}", { status: 401 }) : badToken())),
    );
    const res = await call("me", { cookie: "mr_access=old; mr_refresh=dead" });
    expect(res.status).toBe(401);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/mr_access=;/);
    expect(set).toMatch(/mr_refresh=;/);
  });

  it("keeps the cookies and answers 502 when the API is down during a refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/auth/refresh")) throw new Error("down");
        return badToken();
      }),
    );
    const res = await call("me", { cookie: "mr_access=old; mr_refresh=r" });
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("answers 502 when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await call("me", { cookie: "mr_access=a" })).status).toBe(502);
  });

  it("rejects a write without cookies before reading the body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("me", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a body over the size cap", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("me", {
      method: "POST",
      cookie: "mr_access=a",
      body: "{}",
      headers: { "content-length": String(10 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
