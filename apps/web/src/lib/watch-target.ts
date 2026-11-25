export type Lang = "sub" | "dub";

/** A way to play a title: which source, and its sub or dub. */
export type StreamChoice = { source: string; lang: Lang };

/** Tracks to start on for one play, from the Language menu: the audio ("original" or a dub's
 * language) and the subtitles (a language code or "off"). */
export type StartTracks = { audio?: string; subs?: string };

export function watchHref(source: string, animeId: number, episode: number, lang: Lang = "sub", startAt = 0, tracks?: StartTracks) {
  const query = new URLSearchParams();
  if (lang !== "sub") query.set("lang", lang);
  if (startAt > 0) query.set("t", String(Math.floor(startAt)));
  if (tracks?.audio) query.set("audio", tracks.audio);
  if (tracks?.subs) query.set("subs", tracks.subs);
  const qs = query.toString();
  return `/watch/${source}/${animeId}/${episode}${qs ? `?${qs}` : ""}`;
}

/**
 * The episode to open when someone asks for `wanted` of a title whose source lists `episodes`.
 * A resume point can sit past what has aired (or past a shorter source), so it is clamped to
 * the last available episode; a wanted episode missing from the middle goes to the next one.
 * Returns null when there are no episodes.
 */
export function pickEpisode(episodes: number[], wanted: number): number | null {
  if (episodes.length === 0) return null;
  const sorted = [...episodes].sort((a, b) => a - b);
  return sorted.find((e) => e >= wanted) ?? sorted[sorted.length - 1];
}
