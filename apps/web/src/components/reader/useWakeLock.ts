"use client";

import { useEffect } from "react";

/** Keeps the screen on while a chapter is open, where the browser allows it; asked again when the app comes back. */
export function useWakeLock() {
  useEffect(() => {
    const api = navigator.wakeLock;
    if (!api) return;
    let lock: WakeLockSentinel | null = null;
    let gone = false;
    const acquire = async () => {
      if (gone || document.visibilityState !== "visible") return;
      try {
        lock = await api.request("screen");
      } catch {
        // low battery or a setting: the screen just dims as usual
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, []);
}
