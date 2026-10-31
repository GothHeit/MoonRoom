import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next-intl's own middleware (locale detection) is not under test; every path here already has a locale.
vi.mock("next-intl/middleware", () => ({ default: () => () => NextResponse.next() }));

import proxy from "./proxy";
import { resetSessionState } from "./lib/session";

const tokens = { access_token: "fresh", refresh_token: "next", token_type: "bearer", expires_in: 900 };
const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });
const where = (res: Response) => {
  const location = res.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
};

beforeEach(() => resetSessionState());
afterEach(() => vi.unstubAllGlobals());

describe("auth middleware", () => {
  it("sends a signed-out visitor to login and remembers where they were going", async () => {
    const res = await proxy(req("/pt/list?status=watching"));
    expect(where(res)).toBe("/pt/login?next=%2Flist%3Fstatus%3Dwatching");
  });

  it("does not add next for the home page", async () => {
    expect(where(await proxy(req("/pt")))).toBe("/pt/login");
  });

  it("lets a signed-out visitor see the login page", async () => {
    expect(where(await proxy(req("/pt/login")))).toBeNull();
  });

  it("sends a signed-in user away from the login page", async () => {
    expect(where(await proxy(req("/pt/login", "mr_access=a")))).toBe("/pt");
  });

  it("renews an expired access cookie from the refresh cookie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(tokens)));
    const res = await proxy(req("/pt", "mr_refresh=r"));
    expect(where(res)).toBeNull();
    expect(res.headers.getSetCookie().join("\n")).toContain("mr_access=fresh");
  });

  it("clears the cookies and goes to login when the refresh token is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const res = await proxy(req("/pt/list", "mr_refresh=dead"));
    expect(where(res)).toBe("/pt/login?next=%2Flist");
    expect(res.headers.getSetCookie().join("\n")).toMatch(/mr_refresh=;/);
  });

  it("keeps the session and lets the page fail when the API is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await proxy(req("/pt", "mr_refresh=r"));
    expect(where(res)).toBeNull();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});
