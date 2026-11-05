"use client";

import { useCallback, useSyncExternalStore } from "react";

// Per-TV choice: plain subtitles instead of the styled (ASS) ones, which a slow TV chip may not
// draw in time. Kept on the device, since it is about the TV rather than the person.
const KEY = "tv.plainSubtitles";
const listeners = new Set<() => void>();
// Used when storage is blocked, so the choice still lasts until the page reloads.
let fallback = false;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return fallback;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePlainSubtitles(): [boolean, (on: boolean) => void] {
  const plain = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((on: boolean) => {
    fallback = on;
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // Storage blocked: the fallback above keeps the choice.
    }
    listeners.forEach((l) => l());
  }, []);
  return [plain, set];
}
