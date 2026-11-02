import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const call = (path: string, headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost:3000/api/stream/${path}`, { headers }), {
    params: Promise.resolve({ path: path.split("?")[0].split("/") }),
  } as never);

afterEach(() => vi.unstubAllGlobals());

describe("stream route", () => {
  it("serves the two entry points with the query intact and nothing of the visitor", async () => {
    const fetchMock = vi.fn(async () => new Response("#EXTM3U", { headers: { "content-type": "application/vnd.apple.mpegurl", "set-cookie": "a=b" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("hls?u=x&s=y", { cookie: "mr_access=abc", authorization: "Bearer abc", range: "bytes=0-9" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/watch/hls?u=x&s=y");
    const sent = init.headers as Headers;
    expect(sent.get("range")).toBe("bytes=0-9");
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("authorization")).toBeNull();
  });

  it.each(["me", "auth/login", "hls/extra", "..%2Fme", "rooms"])("refuses %s", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await call(path)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the API is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect((await call("video?token=t")).status).toBe(502);
  });
});
