import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: string, data: unknown) => void;

const instances: FakeHls[] = [];
let supported = true;

class FakeHls {
  static Events = { MANIFEST_PARSED: "manifest", AUDIO_TRACKS_UPDATED: "audio", ERROR: "error" };
  static ErrorTypes = { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
  static isSupported = () => supported;
  handlers = new Map<string, Handler>();
  levels: { height: number; videoCodec?: string }[] = [];
  removed: number[] = [];
  audioTrack = -1;
  nextLevel = -1;
  config: unknown;
  destroyed = false;
  recovered = 0;
  loaded: string | null = null;
  constructor(config?: unknown) {
    this.config = config;
    instances.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
  }
  emit(event: string, data: unknown) {
    this.handlers.get(event)?.(event, data);
  }
  removeLevel(index: number) {
    this.removed.push(index);
    this.levels = this.levels.filter((_l, i) => i !== index);
  }
  recoverMediaError() {
    this.recovered += 1;
  }
  loadSource(url: string) {
    this.loaded = url;
  }
  attachMedia() {}
  destroy() {
    this.destroyed = true;
  }
}

vi.mock("hls.js", () => ({ default: FakeHls }));

const { useHls, hevcSupport, HLS_CONFIG } = await import("./useHls");

const LEVELS = [
  { height: 1080, videoCodec: "hvc1.2.4.L120" },
  { height: 1080, videoCodec: "avc1.640028" },
  { height: 720, videoCodec: "avc1.64001f" },
];

function setup(over: Partial<Parameters<typeof useHls>[0]> = {}) {
  const video = { current: document.createElement("video") };
  const onRetry = vi.fn();
  const onFail = vi.fn();
  const view = renderHook(
    (props: { url: string | null }) =>
      useHls({ video, url: props.url, kind: "hls", defaultAudio: null, onRetry, onFail, ...over }),
    { initialProps: { url: "/api/proxy/stream.m3u8" as string | null } },
  );
  return { video, onRetry, onFail, ...view };
}

async function started() {
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return instances[instances.length - 1];
}

beforeEach(() => {
  instances.length = 0;
  supported = true;
  hevcSupport.failed = false;
});

describe("useHls", () => {
  it("loads the stream and keeps only the HEVC levels when the device decodes it", async () => {
    const { result } = setup();
    const hls = await started();
    expect(hls.loaded).toBe("/api/proxy/stream.m3u8");
    expect(hls.config).toBe(HLS_CONFIG);
    hls.levels = [...LEVELS];
    act(() => hls.emit("manifest", { levels: hls.levels }));
    // Every H.264 level is dropped while the device can play the HEVC original.
    expect(hls.removed).toEqual([2, 1]);
    expect(result.current.qualities.map((q) => q.height)).toEqual([1080]);
  });

  it("falls back to H.264 once when the HEVC cannot be decoded", async () => {
    const { onRetry, onFail, rerender } = setup();
    const hls = await started();
    hls.levels = [...LEVELS];
    act(() => hls.emit("manifest", { levels: hls.levels }));
    act(() => hls.emit("error", { fatal: true, type: "mediaError" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onFail).not.toHaveBeenCalled();

    // The player asks again: a new url, and this time nothing is dropped.
    rerender({ url: null });
    expect(hls.destroyed).toBe(true);
    rerender({ url: "/api/proxy/stream2.m3u8" });
    const second = await waitFor(() => {
      expect(instances).toHaveLength(2);
      return instances[1];
    });
    second.levels = [...LEVELS];
    act(() => second.emit("manifest", { levels: second.levels }));
    expect(second.removed).toEqual([]);
  });

  it("keeps the HEVC on a network error, and skips it for the rest of the visit once it fails", async () => {
    const { onRetry, onFail } = setup();
    const hls = await started();
    hls.levels = [...LEVELS];
    act(() => hls.emit("manifest", { levels: hls.levels }));
    act(() => hls.emit("error", { fatal: true, type: "networkError" }));
    expect(onRetry).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(hevcSupport.failed).toBe(false);

    act(() => hls.emit("error", { fatal: true, type: "mediaError" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // A later episode, in a new player, goes straight to H.264.
    setup();
    const next = await waitFor(() => {
      expect(instances).toHaveLength(2);
      return instances[1];
    });
    next.levels = [...LEVELS];
    act(() => next.emit("manifest", { levels: next.levels }));
    expect(next.removed).toEqual([]);
  });

  it("recovers a media error once, then reports the failure", async () => {
    const { onRetry, onFail } = setup();
    const hls = await started();
    act(() => hls.emit("error", { fatal: true, type: "mediaError" }));
    expect(hls.recovered).toBe(1);
    act(() => hls.emit("error", { fatal: true, type: "mediaError" }));
    expect(hls.recovered).toBe(1);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("ignores errors hls.js recovers from itself", async () => {
    const { onRetry, onFail } = setup();
    const hls = await started();
    act(() => hls.emit("error", { fatal: false, type: "networkError" }));
    expect(onRetry).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });

  it("picks the audio track that matches the source's default", async () => {
    const { result } = setup({ defaultAudio: "ja" });
    const hls = await started();
    act(() =>
      hls.emit("audio", {
        audioTracks: [
          { id: 0, name: "English", lang: "en" },
          { id: 1, name: "Japanese", lang: "ja" },
        ],
      }),
    );
    expect(hls.audioTrack).toBe(1);
    expect(result.current.audioTrack).toBe(1);
    expect(result.current.audioTracks.map((a) => a.label)).toEqual(["English", "Japanese"]);
  });

  it("sets the level and audio track on hls.js when the viewer picks", async () => {
    const { result } = setup();
    const hls = await started();
    act(() => result.current.chooseQuality(2));
    act(() => result.current.chooseAudio(3));
    expect(hls.nextLevel).toBe(2);
    expect(hls.audioTrack).toBe(3);
    expect(result.current.quality).toBe(2);
  });

  it("reports a failure where nothing can play HLS", async () => {
    supported = false;
    const { onFail } = setup();
    await waitFor(() => expect(onFail).toHaveBeenCalledTimes(1));
  });

  it("does nothing for a progressive file", () => {
    const { video } = setup({ kind: "mp4" });
    expect(instances).toHaveLength(0);
    expect(video.current.src).toBe("");
  });
});
