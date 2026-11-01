import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const get = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api", () => ({ api: { POST: post, GET: get, PATCH: patch, PUT: vi.fn() } }));

const { usePlayback } = await import("./usePlayback");
const { useSubtitles } = await import("./useSubtitles");
const { useSkips } = await import("./useSkips");

const PLAY = {
  url: "/watch/stream/abc.m3u8",
  kind: "hls",
  source: "zoko",
  subtitles: [{ lang: "en", label: "English", url: "/s/en.vtt", ass_url: "/s/en.ass" }],
  fonts: { Arial: "/fonts/arial.ttf" },
  skips: [{ kind: "intro", start: 10, end: 90 }],
  default_audio: "ja",
};

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  patch.mockReset().mockResolvedValue({});
});

describe("usePlayback", () => {
  it("keeps what the API answered, with links through the proxy", async () => {
    post.mockResolvedValue({ data: { ...PLAY, source: "animesdigital" } });
    const { result } = renderHook(() => usePlayback("zoko", 1, 3, "sub"));
    await waitFor(() => expect(result.current.url).toBe("/api/proxy/watch/stream/abc.m3u8"));
    expect(post).toHaveBeenCalledWith("/watch/{source}/{anime_id}/episodes/{episode}/play", {
      params: { path: { source: "zoko", anime_id: 1, episode: 3 }, query: { lang: "sub" } },
    });
    expect(result.current.kind).toBe("hls");
    // The source that answered, not the one asked for.
    expect(result.current.answered).toBe("animesdigital");
    expect(result.current.fonts).toEqual({ Arial: "/api/proxy/fonts/arial.ttf" });
    expect(result.current.defaultAudio).toBe("ja");
    expect(result.current.ownSkips).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("reports the error code, or a network error when the call throws", async () => {
    post.mockResolvedValueOnce({ error: { error: { code: "not_available" } } });
    const { result } = renderHook(() => usePlayback("zoko", 1, 3, "sub"));
    await waitFor(() => expect(result.current.error).toBe("not_available"));

    post.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBe("network"));
  });

  it("asks again on retry, clearing the error and the stream first", async () => {
    post.mockResolvedValueOnce({ error: { error: { code: "upstream_failed" } } });
    const { result } = renderHook(() => usePlayback("zoko", 1, 3, "sub"));
    await waitFor(() => expect(result.current.error).toBe("upstream_failed"));

    post.mockResolvedValueOnce({ data: PLAY });
    act(() => result.current.retry());
    expect(result.current.error).toBeNull();
    expect(result.current.url).toBeNull();
    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.current.attempt).toBe(1);
  });
});

describe("useSubtitles", () => {
  const style = { size: "medium" } as never;
  const tracks = [
    { lang: "en", label: "English", url: "/en", ass_url: "/en.ass" },
    { lang: "pt-BR", label: "Português", url: "/pt" },
  ];

  it("starts from the saved language and saves a pick", () => {
    const { result } = renderHook(() => useSubtitles(tracks, "en", style));
    expect(result.current.selected).toBe(0);
    expect(result.current.styled).toBe("/en.ass");
    act(() => result.current.chooseTrack(1));
    expect(result.current.selected).toBe(1);
    expect(patch).toHaveBeenCalledWith("/me", { body: { subtitle_lang: "pt-BR" } });
  });

  it("falls back to the plain copy once the styled one fails, and starts over on new tracks", () => {
    const { result, rerender } = renderHook(({ t }) => useSubtitles(t, "en", style), { initialProps: { t: tracks } });
    act(() => result.current.onAssFail());
    expect(result.current.styled).toBeNull();
    act(() => result.current.chooseTrack(1));

    // A new answer from the API: the pick and the failure no longer hold.
    rerender({ t: [...tracks] });
    expect(result.current.selected).toBe(1); // the saved preference is now pt-BR
    act(() => result.current.chooseTrack(0));
    expect(result.current.styled).toBe("/en.ass");
  });

  it("does not save the unknown language", () => {
    const { result } = renderHook(() => useSubtitles([{ lang: "und", label: "?", url: "/u" }], null, style));
    act(() => result.current.chooseTrack(0));
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("useSkips", () => {
  const own = [{ kind: "intro", start: 10, end: 90 }] as never[];

  it("waits for the length, then adds what the source didn't give", async () => {
    get.mockResolvedValue({ data: [{ kind: "outro", start: 1300, end: 1390 }] });
    const { result, rerender } = renderHook(({ length }) => useSkips(own, 1, 3, length), {
      initialProps: { length: 0 },
    });
    expect(get).not.toHaveBeenCalled();
    expect(result.current).toHaveLength(1);
    rerender({ length: 1420 });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(get).toHaveBeenCalledWith("/watch/skips/{anime_id}/{episode}", {
      params: { path: { anime_id: 1, episode: 3 }, query: { length: 1420 } },
    });
  });

  it("keeps the source's skips when AniSkip fails", async () => {
    get.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useSkips(own, 1, 3, 1420));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current).toEqual(own);
  });
});
