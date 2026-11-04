import { describe, expect, it } from "vitest";

import { bestSample, sample } from "./clock";
import {
  HARD_SEEK_SECONDS,
  MAX_NUDGE,
  commandFor,
  correction,
  expectedPosition,
  newer,
  votesNeeded,
  type Playback,
  type VideoState,
} from "./sync";

const AT = 1_000_000;
const playing: Playback = { playing: true, position: 100, at: AT, version: 2 };
const paused: Playback = { playing: false, position: 100, at: AT, version: 3 };
const timing = { now: 10_000, lastSeekAt: 0, seekCost: 0 };
const video = (over: Partial<VideoState>): VideoState => ({
  currentTime: 100,
  paused: false,
  playbackRate: 1,
  seeking: false,
  wireless: false,
  ...over,
});

describe("expectedPosition", () => {
  it("moves on while playing, holds still when paused, and waits for a scheduled start", () => {
    expect(expectedPosition(playing, AT + 5000)).toBe(105);
    expect(expectedPosition(paused, AT + 5000)).toBe(100);
    expect(expectedPosition(playing, AT - 300)).toBe(100);
  });
});

describe("newer", () => {
  it("never lets older news replace newer", () => {
    expect(newer(paused, playing)).toBe(paused);
    expect(newer(playing, paused)).toBe(paused);
  });
});

describe("commandFor", () => {
  it("sends what the viewer did when the room disagrees", () => {
    expect(commandFor("play", paused, 100, AT)).toEqual({ action: "play", position: 100 });
    expect(commandFor("pause", playing, 103, AT + 3000)).toEqual({ action: "pause", position: 103 });
  });

  it("stays quiet when the room already agrees, so a late joiner doesn't rewind everyone", () => {
    expect(commandFor("play", playing, 0, AT)).toBeNull();
    expect(commandFor("pause", paused, 100, AT)).toBeNull();
  });

  it("sends a seek only when the player moved away from the room", () => {
    expect(commandFor("seek", playing, 101.3, AT + 1000)).toBeNull();
    expect(commandFor("seek", playing, 300, AT + 1000)).toEqual({ action: "seek", position: 300 });
  });
});

describe("correction", () => {
  it("does nothing when the player is close and in the same state", () => {
    expect(correction(playing, video({ currentTime: 101.02 }), AT + 1000, timing)).toBeNull();
  });

  it("holds at the spot and counts down to a scheduled start", () => {
    const fix = correction(playing, video({ currentTime: 97 }), AT - 400, timing);
    expect(fix).toEqual({ seekTo: 100, play: false, rate: null, startIn: 400 });
  });

  it("starts a paused player at the room's spot, aiming ahead by its seek time", () => {
    const fix = correction(playing, video({ currentTime: 10, paused: true }), AT + 2000, { ...timing, seekCost: 0.2 });
    expect(fix?.play).toBe(true);
    expect(fix?.seekTo).toBeCloseTo(102.2);
  });

  it("catches up a little drift by speed, never past the limit, and ahead slows down", () => {
    expect(correction(playing, video({ currentTime: 100.9 }), AT + 1000, timing)?.rate).toBeGreaterThan(1);
    expect(correction(playing, video({ currentTime: 101.3 }), AT + 1000, timing)?.rate).toBeLessThan(1);
    const far = correction(playing, video({ currentTime: 101 - HARD_SEEK_SECONDS + 0.01 }), AT + 1000, timing);
    expect(far?.rate).toBe(1 + MAX_NUDGE);
    expect(far?.seekTo).toBeNull();
  });

  it("stops nudging once close, and goes back to normal speed", () => {
    expect(correction(playing, video({ currentTime: 101.005, playbackRate: 1.03 }), AT + 1000, timing)).toEqual({
      seekTo: null,
      play: null,
      rate: 1,
      startIn: null,
    });
  });

  it("jumps when far off, but not again right after a jump", () => {
    expect(correction(playing, video({ currentTime: 90 }), AT + 1000, timing)?.seekTo).toBeCloseTo(101);
    expect(correction(playing, video({ currentTime: 90 }), AT + 1000, { ...timing, lastSeekAt: 9500 })).toBeNull();
  });

  it("never nudges an AirPlay receiver and gives it a wider window", () => {
    expect(correction(playing, video({ currentTime: 100.6, wireless: true }), AT + 1000, timing)).toBeNull();
    expect(correction(playing, video({ currentTime: 99.5, wireless: true }), AT + 1000, timing)?.seekTo).toBeCloseTo(101);
  });

  it("pauses with the room, exactly where it paused", () => {
    expect(correction(paused, video({ currentTime: 100.3 }), AT, timing)).toEqual({
      seekTo: 100,
      play: false,
      rate: null,
      startIn: null,
    });
  });

  it("waits while the player is still seeking", () => {
    expect(correction(playing, video({ currentTime: 0, seeking: true }), AT + 1000, timing)).toBeNull();
  });
});

describe("clock", () => {
  it("takes the server time as half a round trip old", () => {
    expect(sample(1000, 5100, 1200)).toEqual({ offset: 4000, rtt: 200 });
  });

  it("trusts the quickest round trip", () => {
    expect(bestSample([{ offset: 50, rtt: 300 }, { offset: 12, rtt: 40 }, { offset: -30, rtt: 90 }])).toEqual({
      offset: 12,
      rtt: 40,
    });
    expect(bestSample([])).toBeNull();
  });
});

describe("votesNeeded", () => {
  it("is a strict majority", () => {
    expect([1, 2, 3, 4, 10].map(votesNeeded)).toEqual([1, 2, 2, 3, 6]);
  });
});
