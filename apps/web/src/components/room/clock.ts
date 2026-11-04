"use client";

import { useCallback, useEffect, useRef } from "react";

import { api } from "@/lib/api";

export type ClockSample = { offset: number; rtt: number };

/**
 * The best guess of how far the server's clock is from this one (server = local + offset): the
 * sample with the quickest round trip, since its answer spent the least time on the way.
 */
export function bestSample(samples: ClockSample[]): ClockSample | null {
  return samples.reduce<ClockSample | null>((best, s) => (best === null || s.rtt < best.rtt ? s : best), null);
}

/** One measurement from a request sent at t0 and answered at t1 with the server's time. */
export function sample(t0: number, serverNow: number, t1: number): ClockSample {
  const rtt = t1 - t0;
  return { offset: serverNow + rtt / 2 - t1, rtt };
}

const FIRST_PINGS = 5;
const KEEP = 8;
const EVERY_MS = 30_000;

/**
 * Measures the offset between this device's clock and the server's, NTP style: a few pings on
 * start, then one every 30 s, keeping the quickest of the last few. `measure` runs a fresh
 * round, for when the page comes back from the background.
 */
export function useServerClock() {
  const samples = useRef<ClockSample[]>([]);
  const offset = useRef(0);
  const rtt = useRef<number | null>(null);

  const ping = useCallback(async () => {
    const t0 = Date.now();
    const { data } = await api.GET("/watch/rooms/clock").catch(() => ({ data: undefined }));
    if (!data) return;
    samples.current = [...samples.current, sample(t0, data.now, Date.now())].slice(-KEEP);
    const best = bestSample(samples.current);
    if (best) {
      offset.current = best.offset;
      rtt.current = best.rtt;
    }
  }, []);

  const measure = useCallback(async () => {
    samples.current = [];
    for (let i = 0; i < FIRST_PINGS; i++) await ping();
  }, [ping]);

  useEffect(() => {
    void measure();
    const id = setInterval(() => void ping(), EVERY_MS);
    return () => clearInterval(id);
  }, [measure, ping]);

  const serverNow = useCallback(() => Date.now() + offset.current, []);
  const ready = useCallback(() => rtt.current !== null, []);
  return { serverNow, ready, measure, offset, rtt };
}
