import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenRoute } from "./auth-route";

const tokens = { access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 900 };
const login = (init: { headers?: Record<string, string>; body?: string } = {}) =>
  new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...init.headers },
    body: init.body ?? JSON.stringify({ username: "u", password: "p" }),
  });

afterEach(() => vi.unstubAllGlobals());

describe("tokenRoute (login proxy)", () => {
  it("stores the tokens in httpOnly cookies and returns no body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(tokens)));
    const res = await tokenRoute("/auth/login", login());
    expect(res.status).toBe(204);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toContain("mr_access=a");
    expect(set).toContain("mr_refresh=r");
    expect(set.toLowerCase()).toContain("httponly");
    expect(await res.text()).toBe("");
  });

  it("passes an API refusal through without cookies", async () => {
    const body = JSON.stringify({ error: { code: "invalid_credentials", message: "no" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 401 })));
    const res = await tokenRoute("/auth/login", login());
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(body);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("answers 502 when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await tokenRoute("/auth/login", login())).status).toBe(502);
  });

  it("refuses a non-JSON body (login CSRF)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await tokenRoute("/auth/login", login({ headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await tokenRoute("/auth/login", login({ headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the device headers", async () => {
    const fetchMock = vi.fn(async () => Response.json(tokens));
    vi.stubGlobal("fetch", fetchMock);
    await tokenRoute("/auth/login", login({ headers: { "user-agent": "UA", cookie: "secret=1" } }));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ "user-agent": "UA" });
    expect(init.headers).not.toHaveProperty("cookie");
  });
});
