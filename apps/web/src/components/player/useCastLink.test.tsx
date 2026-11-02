import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("@/lib/api", () => ({ api: { POST: post } }));

const { useCastLink, nativeLink } = await import("./useCastLink");

const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;

beforeEach(() => post.mockReset().mockResolvedValue({ data: { url: "/watch/hls?token=t" } }));
afterEach(() => {
  delete proto.webkitShowPlaybackTargetPicker;
});

describe("useCastLink", () => {
  it("asks for nothing where AirPlay does not exist", () => {
    const { result } = renderHook(() => useCastLink(true, "zoko", 1, 2, "sub", "hls"));
    expect(result.current).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps an absolute link ready for the episode that actually played", async () => {
    proto.webkitShowPlaybackTargetPicker = () => undefined;
    const { result } = renderHook(() => useCastLink(true, "animesdigital", 7, 3, "dub", "hls"));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toBe(`${window.location.origin}/api/stream/hls?token=t&subs=true`);
    expect(post).toHaveBeenCalledWith("/watch/{source}/{anime_id}/episodes/{episode}/link", {
      params: { path: { source: "animesdigital", anime_id: 7, episode: 3 }, query: { lang: "dub", kind: "hls" } },
    });
  });

  it("does not ask before the stream has started", () => {
    proto.webkitShowPlaybackTargetPicker = () => undefined;
    renderHook(() => useCastLink(false, "zoko", 1, 2, "sub", "hls"));
    expect(post).not.toHaveBeenCalled();
  });
});

describe("nativeLink", () => {
  it("asks for subtitles in HLS playlists, not for plain video files", () => {
    expect(nativeLink("/watch/hls?token=t", "hls")).toContain("subs=true");
    expect(nativeLink("/watch/video?token=t", "mp4")).toBe(`${window.location.origin}/api/stream/video?token=t`);
  });
});
