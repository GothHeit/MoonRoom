"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { Lang } from "@/lib/watch-target";

import { streamHref } from "./usePlayback";

/** A link lives ten minutes, so a spare one is renewed well before the viewer could need it. */
const RENEW_MS = 7 * 60 * 1000;

type Picker = { webkitShowPlaybackTargetPicker?: () => void };

/** Whether this browser can send video to an AirPlay receiver (Safari). */
export function airPlaySupported() {
  return typeof HTMLVideoElement !== "undefined" && "webkitShowPlaybackTargetPicker" in (HTMLVideoElement.prototype as Picker);
}

/**
 * A fresh, absolute link to the current episode for a receiver that fetches the stream itself.
 * AirPlay has to be started from a tap, which leaves no time to ask the API first, so one is kept
 * ready (and renewed) while the player is open, but only where AirPlay exists at all. Asking costs
 * the API nothing: it signs a link and looks nothing up until the receiver opens it.
 */
export function useCastLink(enabled: boolean, source: string, animeId: number, episode: number, lang: Lang, kind: string) {
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !airPlaySupported()) return;
    let cancelled = false;
    const renew = () =>
      api
        .POST("/watch/{source}/{anime_id}/episodes/{episode}/link", {
          params: { path: { source, anime_id: animeId, episode }, query: { lang, kind: kind === "mp4" ? "mp4" : "hls" } },
        })
        .then(({ data }) => {
          if (cancelled || !data) return;
          setLink(nativeLink(data.url, kind));
        })
        .catch(() => undefined);
    void renew();
    const timer = setInterval(() => document.visibilityState === "visible" && void renew(), RENEW_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setLink(null);
    };
  }, [enabled, source, animeId, episode, lang, kind]);

  return link;
}

/**
 * The address to hand a native player: absolute, because a receiver on the network has no page to
 * resolve it against, and for HLS asking the API to list the subtitles in the playlist, since
 * the receiver cannot see the ones our page draws.
 */
export function nativeLink(link: string, kind: string) {
  const url = new URL(streamHref(link), window.location.href);
  if (kind !== "mp4") url.searchParams.set("subs", "true");
  return url.href;
}
