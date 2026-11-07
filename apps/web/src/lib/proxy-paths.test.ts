import { describe, expect, it } from "vitest";

import { isAuthFailure, isProxyPathAllowed } from "./proxy-paths";

describe("isProxyPathAllowed", () => {
  it("allows the API areas the browser uses", () => {
    for (const path of [["me"], ["me", "sessions", "x"], ["anime", "1"], ["home"], ["watch", "hls"], ["invites"], ["mal", "link"], ["users", "x", "avatar"], ["users", "lookup"], ["users", "x", "profile"], ["friends"], ["friends", "requests", "x", "accept"], ["notifications"], ["notifications", "x", "read"], ["push", "subscription"], ["push", "test"]]) {
      expect(isProxyPathAllowed(path)).toBe(true);
    }
  });

  it("allows only the phone's side of signing in a TV", () => {
    for (const step of ["lookup", "approve", "deny"]) expect(isProxyPathAllowed(["auth", "device", step])).toBe(true);
    for (const path of [["auth", "device"], ["auth", "device", "token"], ["auth", "device", "approve", "x"], ["auth", "refresh"]]) {
      expect(isProxyPathAllowed(path)).toBe(false);
    }
  });

  it("refuses auth routes, the MAL callback, unknown areas and traversal", () => {
    for (const path of [["auth", "login"], ["mal", "callback"], ["mal"], ["health"], ["users"], ["users", "x"], ["users", "lookup", "x"], ["users", "..", "profile"], ["users", "x", "other"], ["users", "..", "avatar"], ["me", "..", "auth"], ["me", "a/b"], ["me", "a\\b"], ["me", "..x"], []]) {
      expect(isProxyPathAllowed(path)).toBe(false);
    }
  });
});

describe("isAuthFailure", () => {
  const unauthorized = (code: string) => Response.json({ error: { code, message: code } }, { status: 401 });

  it("is true only for a bad access token", async () => {
    expect(await isAuthFailure(unauthorized("not_authenticated"))).toBe(true);
    expect(await isAuthFailure(unauthorized("invalid_token"))).toBe(true);
    expect(await isAuthFailure(unauthorized("mal_session_expired"))).toBe(false);
    expect(await isAuthFailure(new Response("nope", { status: 401 }))).toBe(false);
    expect(await isAuthFailure(Response.json({}, { status: 500 }))).toBe(false);
  });

  it("leaves the body readable for the caller", async () => {
    const response = unauthorized("mal_session_expired");
    await isAuthFailure(response);
    expect((await response.json()).error.code).toBe("mal_session_expired");
  });
});
