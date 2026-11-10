import type { components } from "@app/api-client";

export type AnimeCard = components["schemas"]["AnimeCard"];
export type HomeOut = components["schemas"]["HomeOut"];
export type HomeItem = components["schemas"]["HomeItem"];
export type ProgressOut = components["schemas"]["ProgressOut"];

export const LIST_STATUSES = ["watching", "plan_to_watch", "completed", "on_hold", "dropped"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

export type ListEntry = components["schemas"]["ListItemOut"];

/** The two lists a MyAnimeList account keeps. Each has its own page, statuses and progress unit. */
export type ListKind = "anime" | "manga";

export const animeHref = (id: number) => `/anime/${id}`;

/** Opens an episode without naming a source: the page picks one that has the title. */
export const watchHref = (id: number, episode: number) => `/continue/${id}/${episode}`;

export const posterOf = (card: AnimeCard) => card.main_picture?.large ?? card.main_picture?.medium ?? null;

/** "2024 · ★ 8.4" with whatever the card knows. */
export function captionOf(card: AnimeCard) {
  const parts: string[] = [];
  if (card.start_season) parts.push(String(card.start_season.year));
  if (card.mean) parts.push(`★ ${card.mean.toFixed(1)}`);
  return parts.join(" · ");
}

/** Fraction watched, 0 to 1. Unknown duration counts as just started. */
export function progressFraction(p: ProgressOut) {
  if (p.completed) return 1;
  if (!p.duration_seconds) return 0.02;
  return Math.min(p.position_seconds / p.duration_seconds, 1);
}
