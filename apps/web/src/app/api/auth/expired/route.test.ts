import { describe, expect, it } from "vitest";

import { GET } from "./route";

const get = (query: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost:3000/api/auth/expired${query}`, { headers }));

describe("expired session route", () => {
  it("clears both cookies and goes to the login page in the user's locale", async () => {
    const res = get("?locale=pt");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/pt/login");
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/mr_access=;/);
    expect(set).toMatch(/mr_refresh=;/);
  });

  it("falls back to the default locale for an unknown one", () => {
    const res = get("?locale=//evil.example");
    expect(new URL(res.headers.get("location")!).host).toBe("localhost:3000");
  });

  it("ignores a cross-site request", () => {
    const res = get("?locale=pt", { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});
