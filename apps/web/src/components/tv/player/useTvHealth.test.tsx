import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEALTH_INTERVAL_MS, healthReport, useTvHealth } from "./useTvHealth";

function video() {
  const v = document.createElement("video");
  Object.defineProperty(v, "currentTime", { value: 100, configurable: true });
  Object.defineProperty(v, "buffered", {
    value: { length: 2, start: (i: number) => [0, 90][i], end: (i: number) => [50, 130][i] },
  });
  return v;
}

const INFO = { source: "zoko", animeId: 339, episode: 3, styled: false };

describe("useTvHealth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("measures the buffer around the playhead", () => {
    const report = healthReport(video(), INFO, "tick", {});
    expect(report.buffered_ahead_s).toBe(30);
    expect(report.buffered_behind_s).toBe(10);
    expect(report.buffered_ranges).toBe(2);
    expect(report.source).toBe("zoko");
  });

  it("reports every 30 s with the errors since the last report, and at once on a fatal one", () => {
    const ref = { current: video() };
    const { result } = renderHook(() => useTvHealth(ref, INFO));
    act(() => {
      result.current.onError("fragLoadTimeOut", false);
      result.current.onError("fragLoadTimeOut", false);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(HEALTH_INTERVAL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/proxy/tv/health");
    expect(JSON.parse(init.body).errors).toEqual({ fragLoadTimeOut: 2 });

    act(() => result.current.onError("bufferAppendError", true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.reason).toBe("error");
    expect(body.errors).toEqual({ bufferAppendError: 1 });
  });
});
