import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoState } from "./sync";
import { useRoomSync, type RoomBinding, type VideoControls } from "./useRoomSync";

const NOW = 1_000_000;

function setup(video: VideoState, clockReady = true) {
  const send = vi.fn();
  const controls: VideoControls = {
    read: () => video,
    seek: vi.fn((s: number) => {
      video.currentTime = s;
      video.seeking = true;
    }),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    setRate: vi.fn(),
  };
  const room: RoomBinding = {
    // Playing from 0 since 21 s ago.
    playback: { playing: true, position: 0, at: NOW - 21_000, version: 4 },
    serverNow: () => Date.now(),
    clockReady: () => clockReady,
    canControl: true,
    send,
    setBuffering: vi.fn(),
    pickEpisode: vi.fn(),
    onLocked: vi.fn(),
    topBar: null,
    overlay: null,
  };
  const hook = renderHook(() => useRoomSync(controls, room));
  return { hook, send, controls };
}

describe("useRoomSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("never sends its own slow jump to the room as the viewer's seek", () => {
    const video: VideoState = { currentTime: 10, paused: false, playbackRate: 1, seeking: false, wireless: false };
    const { hook, send, controls } = setup(video);
    expect(controls.seek).toHaveBeenCalledTimes(1);
    // The jump takes 2.5 s to land on a slow network; the room has moved on meanwhile.
    act(() => vi.setSystemTime(NOW + 2500));
    video.seeking = false;
    act(() => hook.result.current.onSeeked());
    expect(send).not.toHaveBeenCalled();
  });

  it("still sends a seek the viewer makes", () => {
    const video: VideoState = { currentTime: 21, paused: false, playbackRate: 1, seeking: false, wireless: false };
    const { hook, send } = setup(video);
    act(() => vi.setSystemTime(NOW + 1000));
    video.currentTime = 300;
    act(() => hook.result.current.onSeeked());
    expect(send).toHaveBeenCalledWith("seek", 300);
  });

  it("doesn't steer until the clock has been measured", () => {
    const video: VideoState = { currentTime: 10, paused: false, playbackRate: 1, seeking: false, wireless: false };
    const { controls } = setup(video, false);
    act(() => vi.advanceTimersByTime(1000));
    expect(controls.seek).not.toHaveBeenCalled();
    expect(controls.setRate).not.toHaveBeenCalled();
  });
});
