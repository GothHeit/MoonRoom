import { describe, expect, it } from "vitest";

import { nudgeVolume, seekVideo, toggleMuted } from "./useVideoControls";

function fake(over: Partial<HTMLVideoElement>) {
  return { currentTime: 0, duration: 100, volume: 1, muted: false, ...over } as HTMLVideoElement;
}

describe("seekVideo", () => {
  it("moves by the delta and stays inside the video", () => {
    const v = fake({ currentTime: 50 });
    seekVideo(v, 10);
    expect(v.currentTime).toBe(60);
    seekVideo(v, -100);
    expect(v.currentTime).toBe(0);
    seekVideo(v, 500);
    expect(v.currentTime).toBe(100);
  });

  it("does nothing before the length is known", () => {
    const v = fake({ currentTime: 5, duration: NaN });
    seekVideo(v, 10);
    expect(v.currentTime).toBe(5);
  });
});

describe("nudgeVolume", () => {
  it("rounds to two decimals and clamps to 0..1", () => {
    const v = fake({ volume: 0.7 });
    nudgeVolume(v, 0.1);
    expect(v.volume).toBe(0.8);
    nudgeVolume(v, 0.5);
    expect(v.volume).toBe(1);
  });

  it("mutes at zero", () => {
    const v = fake({ volume: 0.1 });
    nudgeVolume(v, -0.1);
    expect(v.volume).toBe(0);
    expect(v.muted).toBe(true);
  });
});

describe("toggleMuted", () => {
  it("flips the mute", () => {
    const v = fake({});
    toggleMuted(v);
    expect(v.muted).toBe(true);
    toggleMuted(v);
    expect(v.muted).toBe(false);
  });

  it("restores a usable volume when unmuting from zero", () => {
    const v = fake({ volume: 0, muted: true });
    toggleMuted(v);
    expect(v.muted).toBe(false);
    expect(v.volume).toBe(0.5);
  });
});
