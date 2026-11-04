import { describe, expect, it } from "vitest";

import { correction, type Playback, type VideoState } from "./sync";

/**
 * A room simulated in fake time: the server, and players with their own network delay, clock
 * error, slightly fast or slow decoders, and seeks and starts that take time, all steered by
 * the real `correction`. It checks the steering itself, quickly and the same every run; the
 * browser soak test (pnpm test:e2e:sync) checks it end to end.
 */

type SimPlayer = {
  latency: number; // ms, server to player
  clockError: number; // ms, what the offset measurement got wrong
  speedError: number; // the decoder's own fast or slow
  seekMs: number;
  startMs: number;
  video: VideoState;
  playback: Playback;
  busyUntil: number; // seeking or starting until then
  pendingSeek: number | null;
  pendingPlay: boolean;
  startAt: number | null;
  lastSeekAt: number;
  seeks: number;
};

/** A small deterministic random, so every run is the same. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function simulate(opts: { players: number; seconds: number; events?: { at: number; seekTo: number }[]; seed?: number }) {
  const rand = random(opts.seed ?? 7);
  const STEP = 10;
  const TICK = 250;
  let now = 0;
  let server: Playback = { playing: true, position: 0, at: 400, version: 1 };
  const deliveries: { at: number; player: SimPlayer; playback: Playback }[] = [];
  const players: SimPlayer[] = Array.from({ length: opts.players }, () => ({
    latency: 20 + rand() * 300,
    clockError: (rand() * 2 - 1) * 20,
    speedError: (rand() * 2 - 1) * 0.002,
    seekMs: 100 + rand() * 250,
    startMs: 20 + rand() * 80,
    video: { currentTime: 0, paused: true, playbackRate: 1, seeking: false, wireless: false },
    playback: { playing: false, position: 0, at: 0, version: 0 },
    busyUntil: 0,
    pendingSeek: null,
    pendingPlay: false,
    startAt: null,
    lastSeekAt: -10_000,
    seeks: 0,
  }));
  const publish = () => {
    for (const p of players) deliveries.push({ at: now + p.latency, player: p, playback: server });
  };
  publish();
  const spreads: { t: number; spread: number }[] = [];
  const events = [...(opts.events ?? [])];

  for (; now <= opts.seconds * 1000; now += STEP) {
    // A seek someone makes: scheduled a second ahead, like the server does.
    if (events.length && now >= events[0].at) {
      const e = events.shift()!;
      server = { playing: true, position: e.seekTo, at: now + 1000, version: server.version + 1 };
      publish();
    }
    for (const d of deliveries.filter((d) => d.at <= now)) {
      if (d.playback.version > d.player.playback.version) d.player.playback = d.playback;
    }
    deliveries.splice(0, deliveries.length, ...deliveries.filter((d) => d.at > now));

    for (const p of players) {
      const v = p.video;
      // The decoder moves on while it plays.
      if (!v.paused && now >= p.busyUntil) v.currentTime += (STEP / 1000) * v.playbackRate * (1 + p.speedError);
      if (p.pendingSeek !== null && now >= p.busyUntil) {
        v.seeking = false;
        p.pendingSeek = null;
      }
      if (p.pendingPlay && now >= p.busyUntil) {
        p.pendingPlay = false;
        v.paused = false;
      }
      if (p.startAt !== null && now >= p.startAt) {
        p.startAt = null;
        p.pendingPlay = true;
        p.busyUntil = now + p.startMs;
      }
      if (now % TICK !== 0) continue;
      const fix = correction(p.playback, v, now + p.clockError, { now, lastSeekAt: p.lastSeekAt, seekCost: p.seekMs / 1000 });
      if (!fix) continue;
      if (fix.rate !== null) v.playbackRate = fix.rate;
      if (fix.seekTo !== null) {
        v.currentTime = fix.seekTo;
        v.seeking = true;
        p.pendingSeek = fix.seekTo;
        p.busyUntil = now + p.seekMs;
        p.lastSeekAt = now;
        p.seeks++;
      }
      if (fix.play === false) v.paused = true;
      if (fix.play === true && v.paused && !p.pendingPlay) {
        p.pendingPlay = true;
        p.busyUntil = Math.max(p.busyUntil, now + p.startMs);
      }
      p.startAt = fix.startIn !== null ? now + fix.startIn : null;
    }
    const positions = players.map((p) => p.video.currentTime);
    spreads.push({ t: now, spread: Math.max(...positions) - Math.min(...positions) });
  }
  return { spreads, players };
}

const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];

describe("room sync, simulated", () => {
  // Each viewer's clock is up to 20 ms off and drift under 25 ms is left alone, so two frames
  // (80 ms) between the furthest-apart of five is as close as it gets.
  it("keeps five viewers on mixed networks within two frames of each other", () => {
    const { spreads, players } = simulate({ players: 5, seconds: 120 });
    const steady = spreads.filter((s) => s.t > 5000).map((s) => s.spread);
    expect(p95(steady)).toBeLessThan(0.08);
    // Small drift is made up by speed, not by jumping.
    expect(players.every((p) => p.seeks <= 1)).toBe(true);
  });

  it("brings everyone back together soon after a seek", () => {
    const { spreads } = simulate({ players: 5, seconds: 60, events: [{ at: 20_000, seekTo: 300 }, { at: 40_000, seekTo: 45 }] });
    for (const at of [20_000, 40_000]) {
      const after = spreads.filter((s) => s.t > at + 3000 && s.t < at + 15_000).map((s) => s.spread);
      expect(p95(after)).toBeLessThan(0.1);
    }
  });

  it("holds up across many random rooms", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { spreads } = simulate({ players: 4, seconds: 40, seed });
      expect(p95(spreads.filter((s) => s.t > 6000).map((s) => s.spread))).toBeLessThan(0.1);
    }
  });
});
