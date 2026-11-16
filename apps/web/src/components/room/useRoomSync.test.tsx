import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoState } from "./sync";
import { PEER_REPORT_MS, useRoomSync, type RoomBinding, type VideoControls } from "./useRoomSync";

const NOW = 1_000_000;

function setup(video: VideoState, clockReady = true, offset: number | null = null) {
  const send = vi.fn();
  const report = vi.fn<(position: number, uplink: number, trim: number) => Promise<number | null>>(() =>
    Promise.resolve(offset),
  );
  const setTrim = vi.fn();
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
    peers: { report, trim: () => 0, setTrim, rtt: () => 40 },
  };
  const hook = renderHook(() => useRoomSync(controls, room));
  return { hook, send, controls, report, setTrim };
}

/** Lets time pass with the video keeping up with the room, as a synced player does. */
async function playFor(video: VideoState, ms: number) {
  for (let t = 0; t < ms; t += 250) {
    video.currentTime += 0.25;
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
  }
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

  it("tells the room where it is now and then, and trims its clock toward the group", async () => {
    const video: VideoState = { currentTime: 21, paused: false, playbackRate: 1, seeking: false, wireless: false };
    const { report, setTrim } = setup(video, true, 0.2);
    await playFor(video, PEER_REPORT_MS);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.closeTo(26, 0), 20, 0);
    expect(setTrim).toHaveBeenCalledWith(expect.closeTo(0.1));
  });

  it("does not report while paused", async () => {
    const paused: VideoState = { currentTime: 21, paused: true, playbackRate: 1, seeking: false, wireless: false };
    const a = setup(paused, true, 0.2);
    await playFor(paused, PEER_REPORT_MS);
    expect(a.report).not.toHaveBeenCalled();
  });

  it("does nothing with an answer of null, as when it is alone in the room", async () => {
    const playing: VideoState = { currentTime: 21, paused: false, playbackRate: 1, seeking: false, wireless: false };
    const b = setup(playing, true, null);
    await playFor(playing, PEER_REPORT_MS);
    expect(b.report).toHaveBeenCalled();
    expect(b.setTrim).not.toHaveBeenCalled();
  });
});
