"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";

import type { LanguageChoice } from "./languageMenu";

const warmed = new Set<string>();

/**
 * The Language menu's choices for an episode, once `want` is set: null while the API is still
 * checking the sources. An answer that fails leaves the menu empty rather than retrying.
 */
export function useLanguages(animeId: number, episode: number, want: boolean) {
  const [choices, setChoices] = useState<LanguageChoice[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!want || choices || failed) return;
    let cancelled = false;
    api
      .GET("/watch/languages/{anime_id}/{episode}", { params: { path: { anime_id: animeId, episode } } })
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setChoices(data);
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [animeId, episode, want, choices, failed]);

  return { choices, failed };
}

/** Has the API check an episode's languages ahead of time (the next one), once per visit. */
export function warmLanguages(animeId: number, episode: number) {
  const key = `${animeId}/${episode}`;
  if (warmed.has(key)) return;
  warmed.add(key);
  void api
    .GET("/watch/languages/{anime_id}/{episode}", { params: { path: { anime_id: animeId, episode } } })
    .catch(() => undefined);
}
