"use client";

import { useCallback, useEffect, useRef } from "react";

import { api } from "@/lib/api";

export type ClockSample = { offset: number; rtt: number };

/**
 * The best guess of how far the server's clock is from this one (server = local + offset): the
 * median of the quickest quarter of the samples. The quick ones spent the least time on the way,
 * so they are the least skewed; the median keeps one lucky outlier from deciding alone.
 */
export function bestSample(samples: ClockSample[]): ClockSample | null {
  if (samples.length === 0) return null;
  const quick = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(samples.length / 4)));
  return { offset: median(quick.map((s) => s.offset)), rtt: median(quick.map((s) => s.rtt)) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One measurement from a request sent at t0 and answered at t1 with the server's time. */
export function sample(t0: number, serverNow: number, t1: number): ClockSample {
  const rtt = t1 - t0;
  return { offset: serverNow + rtt / 2 - t1, rtt };
}

const JOIN_PINGS = 20;
const REFRESH_PINGS = 8;
const KEEP = 24;
/** Samples needed before the clock is trusted enough to steer by. */
const READY_AT = 5;
const EVERY_MS = 30_000;
/** However far the group check pushes this viewer, never more than this (ms). */
const MAX_TRIM_MS = 1000;

/**
 * Measures the offset between this device's clock and the server's, NTP style: about twenty pings
 * on start, then a handful every 30 s, keeping the last few dozen and trusting the quickest
 * quarter. `measure` runs a fresh round, for when the page comes back from the background.
 *
 * Even then the offset is only as good as the guess that the way there and back took equally
 * long, which through a tunnel it doesn't. `setTrim` lets the room's group check shave off what is
 * left: it shifts this viewer's idea of server time a little, toward where the others are.
 */
export function useServerClock() {
  const samples = useRef<ClockSample[]>([]);
  const offset = useRef(0);
  const trim = useRef(0);
  const rtt = useRef<number | null>(null);
  const ready = useRef(false);
  const running = useRef(false);

  const ping = useCallback(async () => {
    const t0 = Date.now();
    const { data } = await api.GET("/watch/rooms/clock").catch(() => ({ data: undefined }));
    if (!data) return;
    samples.current = [...samples.current, sample(t0, data.now, Date.now())].slice(-KEEP);
    const best = bestSample(samples.current);
    if (best && (samples.current.length >= READY_AT || !ready.current)) {
      offset.current = best.offset;
      rtt.current = best.rtt;
      if (samples.current.length >= READY_AT) ready.current = true;
    }
  }, []);

  const burst = useCallback(
    async (count: number) => {
      if (running.current) return;
      running.current = true;
      try {
        for (let i = 0; i < count; i++) await ping();
      } finally {
        running.current = false;
      }
    },
    [ping],
  );

  const measure = useCallback(async () => {
    samples.current = [];
    await burst(JOIN_PINGS);
  }, [burst]);

  useEffect(() => {
    void measure();
    const id = setInterval(() => void burst(REFRESH_PINGS), EVERY_MS);
    return () => clearInterval(id);
  }, [measure, burst]);

  const serverNow = useCallback(() => Date.now() + offset.current + trim.current, []);
  const isReady = useCallback(() => ready.current, []);
  /** Sets how far (seconds) this viewer's idea of server time is shifted, within a limit. */
  const setTrim = useCallback((seconds: number) => {
    trim.current = Math.max(-MAX_TRIM_MS, Math.min(MAX_TRIM_MS, seconds * 1000));
  }, []);
  return { serverNow, ready: isReady, measure, setTrim, offset, trim, rtt };
}
