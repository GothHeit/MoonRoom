"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// A press closer than this to the previous one counts as the key being held (or tapped fast).
const REPEAT_MS = 600;
// How long the bar waits after the last press before the video jumps there.
export const COMMIT_MS = 700;

/** Seconds per press: 10, then 30 after a few held presses, then 60 on a long hold. */
export function stepFor(streak: number): number {
  if (streak < 8) return 10;
  if (streak < 20) return 30;
  return 60;
}

/** Where a press of `direction` from `from` lands, staying inside the video. */
export function seekTarget(from: number, direction: 1 | -1, streak: number, duration: number): number {
  return Math.min(Math.max(from + direction * stepFor(streak), 0), Math.max(duration - 1, 0));
}

function jump(v: HTMLVideoElement, to: number) {
  v.currentTime = to;
}

/**
 * Seeking with the remote: each press moves a target on the bar (faster while the key is held),
 * and the video only jumps there once the presses stop. A TV can't fetch a new spot in the stream
 * every tenth of a second, and the person sees where they will land before it loads.
 */
export function useTvSeek(video: RefObject<HTMLVideoElement | null>) {
  const [target, setTarget] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const last = useRef(0);
  const streak = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const commit = useCallback(() => {
    clearTimeout(timer.current);
    const v = video.current;
    const to = pending.current;
    pending.current = null;
    setTarget(null);
    if (v && to !== null) jump(v, to);
  }, [video]);

  const nudge = useCallback(
    (direction: 1 | -1) => {
      const v = video.current;
      if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
      const now = Date.now();
      streak.current = now - last.current < REPEAT_MS ? streak.current + 1 : 0;
      last.current = now;
      const to = seekTarget(pending.current ?? v.currentTime, direction, streak.current, v.duration);
      pending.current = to;
      setTarget(to);
      clearTimeout(timer.current);
      timer.current = setTimeout(commit, COMMIT_MS);
    },
    [video, commit],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return { target, nudge, commit, pending: () => pending.current !== null };
}
