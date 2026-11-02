"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { ReadingSettings } from "@/lib/manga";

import { loadSettings, saveSettings } from "./navigation";

// Reader settings per title, kept in the browser. A store so the first paint on the client
// matches the server (defaults) and the saved choice shows right after.
const listeners = new Set<() => void>();
// Snapshots must be stable between reads: one object per (title, raw value).
let snapshot: { key: string; value: ReadingSettings } | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(mangaId: number, defaults: ReadingSettings): ReadingSettings {
  const value = loadSettings(mangaId, defaults);
  const key = `${mangaId}:${value.mode}:${value.direction}`;
  if (snapshot?.key !== key) snapshot = { key, value };
  return snapshot.value;
}

export function useReadingSettings(mangaId: number, defaults: ReadingSettings) {
  const settings = useSyncExternalStore(
    subscribe,
    () => read(mangaId, defaults),
    () => defaults,
  );
  const update = useCallback(
    (patch: Partial<ReadingSettings>) => {
      saveSettings(mangaId, { ...loadSettings(mangaId, defaults), ...patch });
      listeners.forEach((l) => l());
    },
    [mangaId, defaults],
  );
  return [settings, update] as const;
}
