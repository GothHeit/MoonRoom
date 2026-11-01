"use client";

import { useCallback, useState } from "react";

import { api } from "@/lib/api";

import type { SubtitleStyle } from "./subtitleStyle";
import type { Track } from "./usePlayback";

/** The track to show: the saved language if this episode has it, else Portuguese, then English. */
export function pickTrack(tracks: Track[], preference: string | null): number {
  if (preference === "off") return -1;
  for (const wanted of [preference, "pt-BR", "pt", "en"]) {
    const index = tracks.findIndex((t) => t.lang === wanted);
    if (wanted && index >= 0) return index;
  }
  return -1;
}

/**
 * Which subtitle track is shown, whether the styled (ASS) copy could be drawn, and the look of
 * the text. A pick or a failure only holds for the tracks it was made on: a new answer from the
 * API (another episode, a retry) starts over from the saved preference.
 */
export function useSubtitles(tracks: Track[], savedLang: string | null, savedStyle: SubtitleStyle) {
  const [preference, setPreference] = useState(savedLang);
  const [style, setStyle] = useState(savedStyle);
  // Set when the viewer picks a track here; then it wins over the saved preference.
  const [picked, setPicked] = useState<{ tracks: Track[]; index: number } | null>(null);
  // Set when styled subtitles can't be drawn here; the WebVTT copies are shown instead.
  const [failedOn, setFailedOn] = useState<Track[] | null>(null);

  const chosen = picked && picked.tracks === tracks ? picked.index : null;
  const selected = chosen ?? pickTrack(tracks, preference);
  const styled = failedOn === tracks ? null : tracks[selected]?.ass_url;
  const onAssFail = useCallback(() => setFailedOn(tracks), [tracks]);

  function chooseTrack(index: number) {
    setPicked({ tracks, index });
    const lang = index < 0 ? "off" : tracks[index].lang;
    setPreference(lang);
    if (lang === "und") return;
    // Best effort: the choice only matters again on the next episode.
    void api.PATCH("/me", { body: { subtitle_lang: lang } }).catch(() => undefined);
  }

  function changeStyle(next: SubtitleStyle) {
    setStyle(next);
    // Best effort, like the subtitle language: the look still applies to this episode.
    void api.PUT("/watch/preferences", { body: next }).catch(() => undefined);
  }

  return { selected, styled, onAssFail, chooseTrack, style, changeStyle };
}
