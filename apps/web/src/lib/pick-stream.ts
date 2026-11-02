import type { StreamChoice } from "./watch-target";

type Found = { sources: string[]; choice?: StreamChoice | null };

/** The pseudo-source that lets the API choose the best version for the viewer, episode by episode. */
export const AUTO_SOURCE = "auto";

/**
 * Where to play a title from: the source and sub/dub the user picked in the player, else the
 * automatic choice (the API picks the best version of each episode) when any source has the title. A pick that lists no episodes (its dub was taken
 * down, or the source is failing right now) falls through to the default, but stays saved.
 * Returns the stream with its episode list, or null when neither lists any.
 */
export async function pickStream<T extends { episodes: number[] }>(
  found: Found | undefined,
  episodesOf: (choice: StreamChoice) => Promise<T | undefined>,
): Promise<{ choice: StreamChoice; listed: T } | null> {
  const fallback: StreamChoice | undefined = found?.sources.length ? { source: AUTO_SOURCE, lang: "sub" } : undefined;
  const picked = found?.choice ?? undefined;
  const candidates = [picked, fallback].filter((c): c is StreamChoice => c !== undefined);
  if (picked && fallback && picked.source === fallback.source && picked.lang === fallback.lang) candidates.pop();
  for (const choice of candidates) {
    const listed = await episodesOf(choice).catch(() => undefined);
    if (listed && listed.episodes.length > 0) return { choice, listed };
  }
  return null;
}
