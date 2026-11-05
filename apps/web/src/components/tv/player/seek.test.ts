import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMIT_MS, seekTarget, stepFor, useTvSeek } from "./seek";

describe("remote seeking", () => {
  it("steps 10 s, then faster while the key is held", () => {
    expect(stepFor(0)).toBe(10);
    expect(stepFor(8)).toBe(30);
    expect(stepFor(20)).toBe(60);
  });

  it("stays inside the video", () => {
    expect(seekTarget(5, -1, 0, 100)).toBe(0);
    expect(seekTarget(95, 1, 0, 100)).toBe(99);
    expect(seekTarget(50, 1, 0, 100)).toBe(60);
  });

  describe("useTvSeek", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("moves a target with each press and only jumps once the presses stop", () => {
      const video = { currentTime: 20, duration: 300 } as HTMLVideoElement;
      const { result } = renderHook(() => useTvSeek({ current: video }));
      act(() => result.current.nudge(1));
      act(() => result.current.nudge(1));
      expect(result.current.target).toBe(40);
      expect(video.currentTime).toBe(20);
      act(() => vi.advanceTimersByTime(COMMIT_MS));
      expect(video.currentTime).toBe(40);
      expect(result.current.target).toBeNull();
    });

    it("jumps at once when committed", () => {
      const video = { currentTime: 20, duration: 300 } as HTMLVideoElement;
      const { result } = renderHook(() => useTvSeek({ current: video }));
      act(() => result.current.nudge(-1));
      expect(result.current.pending()).toBe(true);
      act(() => result.current.commit());
      expect(video.currentTime).toBe(10);
      expect(result.current.pending()).toBe(false);
    });
  });
});
