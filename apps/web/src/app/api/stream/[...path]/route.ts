import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { API_URL } from "@/lib/config";

// Where a TV, an AirPlay receiver or any other native player fetches video from. They send no
// cookies, so unlike /api/proxy this route asks for nothing: the link itself names the user and
// the login session, is signed by the API, and expires. Only the two playback entry points are
// reachable, and nothing of the visitor (cookies, authorization) is passed on.
const ENTRY_POINTS = ["hls", "video"];
const FORWARD_REQUEST = ["range", "if-none-match"];
const FORWARD_RESPONSE = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "x-content-type-options",
];

export async function GET(request: NextRequest, ctx: RouteContext<"/api/stream/[...path]">) {
  const { path } = await ctx.params;
  if (path.length !== 1 || !ENTRY_POINTS.includes(path[0])) {
    return NextResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  }
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/watch/${path[0]}${request.nextUrl.search}`, {
      headers,
      cache: "no-store",
      redirect: "manual",
      // Stops the download when the player goes away.
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: { code: "network", message: "API unreachable" } }, { status: 502 });
  }
  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // The link carries a credential: keep it out of Referer headers and search engines.
  out.set("referrer-policy", "no-referrer");
  out.set("x-robots-tag", "noindex");
  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}
