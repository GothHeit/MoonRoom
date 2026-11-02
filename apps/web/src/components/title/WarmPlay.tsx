"use client";

import { useEffect } from "react";

import { preloadPlayer, warmPlayback } from "@/lib/warm-playback";
import type { Lang } from "@/lib/watch-target";

type Props = { source: string; animeId: number; episode: number; lang: Lang };

/**
 * Renders nothing. Once the title page is idle, it gets the episode its Play button opens ready:
 * the API resolves the stream and the browser downloads the player code, so play starts sooner.
 */
export function WarmPlay({ source, animeId, episode, lang }: Props) {
  useEffect(() => {
    const warm = () => {
      warmPlayback(source, animeId, episode, lang);
      preloadPlayer();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 500);
    return () => clearTimeout(id);
  }, [source, animeId, episode, lang]);
  return null;
}
