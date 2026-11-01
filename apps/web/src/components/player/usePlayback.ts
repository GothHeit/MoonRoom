"use client";

import { errorCode } from "@app/api-client";
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";

import type { Lang } from "@/lib/watch-target";

import type { Skip } from "./skips";

export type Track = { lang: string; label: string; url: string; ass_url?: string | null };

/**
 * Asks the API to start the episode and keeps what it answered: the stream URL and kind, the
 * source that actually answered (a fallback when the requested one failed), subtitle tracks,
 * fonts, the source's own skips and its default audio. `retry` asks again.
 */
export function usePlayback(source: string, animeId: number, episode: number, lang: Lang) {
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("mp4");
  const [tracks, setTracks] = useState<Track[]>([]);
  // Fonts for the styled subtitles, through the proxy like the tracks.
  const [fonts, setFonts] = useState<Record<string, string>>({});
  // The source that answered; another enabled one when the requested source failed.
  const [answered, setAnswered] = useState(source);
  const [ownSkips, setOwnSkips] = useState<Skip[]>([]);
  const [defaultAudio, setDefaultAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .POST("/watch/{source}/{anime_id}/episodes/{episode}/play", {
        params: { path: { source, anime_id: animeId, episode }, query: { lang } },
      })
      .then(({ data, error: body }) => {
        if (cancelled) return;
        if (data) {
          setKind(data.kind);
          setAnswered(data.source);
          setOwnSkips(data.skips ?? []);
          setDefaultAudio(data.default_audio ?? null);
          setTracks(data.subtitles ?? []);
          setFonts(Object.fromEntries(Object.entries(data.fonts ?? {}).map(([name, link]) => [name, `/api/proxy${link}`])));
          setUrl(`/api/proxy${data.url}`);
        } else setError(errorCode(body));
      })
      .catch(() => !cancelled && setError("network"));
    return () => {
      cancelled = true;
    };
  }, [source, animeId, episode, lang, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setUrl(null);
    setAttempt((a) => a + 1);
  }, []);

  return { attempt, url, kind, tracks, fonts, answered, ownSkips, defaultAudio, error, setError, retry };
}
