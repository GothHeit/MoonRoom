"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

import { isCompleted, SAVE_INTERVAL_MS, saveProgress } from "./progress";

/**
 * Saves the position of `video` every 10 s, when the tab is hidden or closed, and when the
 * player goes away. The player also calls `save` on pause and at the end, and `onTime` on every
 * time update so crossing 90 % marks the episode watched right away.
 */
export function useProgressSaver(video: RefObject<HTMLVideoElement | null>, animeId: number, episode: number, onFinished?: () => void) {
  const lastSaved = useRef<number | null>(null);
  const completedSent = useRef(false);

  const saveFrom = useCallback(
    (el: HTMLVideoElement | null, keepalive = false) => {
      if (!el) return;
      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      const position = el.currentTime;
      if (!duration || position <= 0) return;
      const completed = isCompleted(position, duration);
      const newlyCompleted = completed && !completedSent.current;
      if (!newlyCompleted && lastSaved.current !== null && Math.abs(position - lastSaved.current) < 1) return;
      lastSaved.current = position;
      if (completed) completedSent.current = true;
      if (newlyCompleted) onFinished?.();
      void saveProgress(
        animeId,
        episode,
        { position_seconds: position, duration_seconds: duration, completed },
        keepalive,
      );
    },
    [animeId, episode, onFinished],
  );

  const onTime = useCallback(
    (el: HTMLVideoElement) => {
      if (!completedSent.current && isCompleted(el.currentTime, el.duration)) saveFrom(el);
    },
    [saveFrom],
  );

  useEffect(() => {
    // The element is gone by the time the cleanup runs, so keep hold of it here.
    const el = video.current;
    const interval = setInterval(() => saveFrom(el), SAVE_INTERVAL_MS);
    const onVisibility = () => document.visibilityState === "hidden" && saveFrom(el, true);
    const onPageHide = () => saveFrom(el, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      saveFrom(el, true);
    };
  }, [saveFrom, video]);

  return { save: saveFrom, onTime };
}
