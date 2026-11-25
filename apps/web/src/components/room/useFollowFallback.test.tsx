import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { recentFollow, useFollowFallback } from "./useFollowFallback";
import type { RoomBinding } from "./useRoomSync";

const asked = { source: "animesdigital", lang: "sub" as const };
const zoko = { source: "zoko", lang: "sub" as const };

function room(switchStream?: RoomBinding["switchStream"]) {
  return { switchStream } as RoomBinding;
}

describe("useFollowFallback", () => {
  it("moves the room to the stream that played when the host's pick fell back", () => {
    const switchStream = vi.fn();
    const { result } = renderHook(() =>
      useFollowFallback({ room: room(switchStream), animeId: 1, episode: 1, asked, playing: zoko, ready: true, automatic: false }),
    );
    expect(result.current).toBe(true);
    expect(switchStream).toHaveBeenCalledWith(zoko);
    // The player the room reloads tells the host why.
    expect(recentFollow(1, 1)).toEqual({ failed: asked, playing: zoko });
    expect(recentFollow(1, 2)).toBeNull();
  });

  it("leaves the room alone for guests, when the asked stream played, and while loading", () => {
    const switchStream = vi.fn();
    const cases = [
      { room: room(undefined), playing: zoko, ready: true },
      { room: room(switchStream), playing: asked, ready: true },
      { room: room(switchStream), playing: zoko, ready: false },
    ];
    for (const c of cases) {
      const { result } = renderHook(() => useFollowFallback({ ...c, animeId: 2, episode: 1, asked, automatic: false }));
      expect(result.current).toBe(false);
    }
    expect(switchStream).not.toHaveBeenCalled();
  });

  it("stops after a few moves on one episode, so flaky sources can't bounce the room", () => {
    const switchStream = vi.fn();
    for (let i = 0; i < 5; i++) {
      renderHook(() => useFollowFallback({ room: room(switchStream), animeId: 3, episode: 1, asked, playing: zoko, ready: true, automatic: false }));
    }
    expect(switchStream).toHaveBeenCalledTimes(3);
  });
});
