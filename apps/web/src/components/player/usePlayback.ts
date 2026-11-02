"use client";

import { errorCode } from "@app/api-client";
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";

import type { Lang } from "@/lib/watch-target";

import type { Skip } from "./skips";

export type Track = { lang: string; label: string; url: string; ass_url?: string | null };

// Stable empty values while nothing has answered, so effects keyed on them don't rerun.
const NONE: Track[] = [];
const NO_FONTS: Record<string, string> = {};
const NO_SKIPS: Skip[] = [];

/** What the API answered for the episode, with every link already pointing at the proxy. */
export type Playback = {
  url: string;
  kind: string;
  tracks: Track[];
  /** Fonts for the styled subtitles. */
  fonts: Record<string, string>;
  /** The source that answered; another enabled one when the requested source failed. */
  answered: string;
  /** Sub or dub as played: the automatic choice picks it. */
  answeredLang: Lang;
  ownSkips: Skip[];
  defaultAudio: string | null;
  /** The tallest quality the viewer asked for, if they set a limit. */
  maxHeight: number | null;
};

/**
 * Asks the API to start the episode and keeps what it answered: the stream URL and kind, the
 * source that actually answered (a fallback when the requested one failed), subtitle tracks,
 * fonts, the source's own skips and its default audio. All of it is one value, set at once, so
 * no render ever sees a new stream with the previous one's tracks. `retry` asks again.
 */
export function usePlayback(source: string, animeId: number, episode: number, lang: Lang) {
  const [attempt, setAttempt] = useState(0);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .POST("/watch/{source}/{anime_id}/episodes/{episode}/play", {
        // A retry follows a failure, which a recently checked copy of the stream may have
        // caused: have the API check it again, and fall back to another source if it is gone.
        params: { path: { source, anime_id: animeId, episode }, query: attempt > 0 ? { lang, fresh: true } : { lang } },
      })
      .then(({ data, error: body }) => {
        if (cancelled) return;
        if (data)
          setPlayback({
            url: `/api/proxy${data.url}`,
            kind: data.kind,
            tracks: data.subtitles ?? [],
            fonts: Object.fromEntries(Object.entries(data.fonts ?? {}).map(([name, link]) => [name, `/api/proxy${link}`])),
            answered: data.source,
            answeredLang: data.lang,
            ownSkips: data.skips ?? [],
            defaultAudio: data.default_audio ?? null,
            maxHeight: data.max_resolution ?? null,
          });
        else setError(errorCode(body));
      })
      .catch(() => !cancelled && setError("network"));
    return () => {
      cancelled = true;
    };
  }, [source, animeId, episode, lang, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setPlayback(null);
    setAttempt((a) => a + 1);
  }, []);

  return {
    attempt,
    url: playback?.url ?? null,
    kind: playback?.kind ?? "mp4",
    tracks: playback?.tracks ?? NONE,
    fonts: playback?.fonts ?? NO_FONTS,
    answered: playback?.answered ?? source,
    answeredLang: playback?.answeredLang ?? lang,
    ownSkips: playback?.ownSkips ?? NO_SKIPS,
    defaultAudio: playback?.defaultAudio ?? null,
    maxHeight: playback?.maxHeight ?? null,
    error,
    setError,
    retry,
  };
}
