"use client";

import { api } from "@/lib/api";
import type { Lang } from "@/lib/watch-target";

const warmed = new Set<string>();

/**
 * Asks the API to resolve an episode in the background, so pressing play on it later finds the
 * stream already looked up and checked. Best effort, and once per episode per visit.
 */
export function warmPlayback(source: string, animeId: number, episode: number, lang: Lang) {
  const key = `${source}/${animeId}/${episode}/${lang}`;
  if (warmed.has(key)) return;
  warmed.add(key);
  void api
    .POST("/watch/{source}/{anime_id}/episodes/{episode}/prepare", {
      params: { path: { source, anime_id: animeId, episode }, query: { lang } },
    })
    .catch(() => undefined);
}

/** Downloads the HLS player code ahead of the watch page, which otherwise fetches it on open. */
export function preloadPlayer() {
  void import("hls.js").catch(() => undefined);
}
