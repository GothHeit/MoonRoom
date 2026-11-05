import { afterEach, describe, expect, it, vi } from "vitest";

import { pollDeviceLogin, startDeviceLogin } from "./device-login";

const post = (path: string, cookie?: string, origin = "http://localhost:3000") =>
  new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { host: "localhost:3000", origin, ...(cookie ? { cookie } : {}) },
  });

afterEach(() => vi.unstubAllGlobals());

describe("TV sign-in routes", () => {
  it("keeps the TV's secret in an httpOnly cookie and shows only the code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ device_token: "secret", user_code: "BCDF-GHJK", expires_in: 600, interval: 5 }, { status: 201 })));
    const res = await startDeviceLogin(post("/api/auth/device/start"));
    const body = await res.json();
    expect(body).toEqual({ user_code: "BCDF-GHJK", expires_in: 600, interval: 5 });
    const cookie = res.headers.getSetCookie().join("\n");
    expect(cookie).toMatch(/mr_device=secret/);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it("refuses a cross-site start", async () => {
    const res = await startDeviceLogin(post("/api/auth/device/start", undefined, "https://evil.example"));
    expect(res.status).toBe(403);
  });

  it("answers pending until the phone approves", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "pending", tokens: null })));
    const res = await pollDeviceLogin(post("/api/auth/device/poll", "mr_device=secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("turns an approval into session cookies and drops the secret", async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ status: "approved", tokens: { access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 900 } }),
    );
    vi.stubGlobal("fetch", fetch);
    const res = await pollDeviceLogin(post("/api/auth/device/poll", "mr_device=secret"));
    expect(res.status).toBe(204);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(/mr_access=a/);
    expect(cookies).toMatch(/mr_refresh=r/);
    expect(cookies).toMatch(/mr_device=;/);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ device_token: "secret" });
  });

  it("drops the secret when the code expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "device_login_expired" } }, { status: 410 })));
    const res = await pollDeviceLogin(post("/api/auth/device/poll", "mr_device=secret"));
    expect(res.status).toBe(410);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/mr_device=;/);
  });

  it("asks for a new code without calling the API when there is no secret", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await pollDeviceLogin(post("/api/auth/device/poll"))).status).toBe(410);
    expect(fetch).not.toHaveBeenCalled();
  });
});
