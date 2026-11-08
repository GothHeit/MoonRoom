import type { components } from "@app/api-client";

import { drain } from "@/lib/drain";

type Progress = components["schemas"]["ProgressOut"];
type ProgressIn = components["schemas"]["ProgressIn"];

export const SAVE_INTERVAL_MS = 10_000;
// Matches the API: past this share of the episode it counts as watched.
export const COMPLETED_RATIO = 0.9;
// Resuming this close to either end isn't worth it.
const RESUME_MIN_SECONDS = 5;
const RESUME_END_MARGIN_SECONDS = 15;

/** Where to start an episode, from its saved progress. 0 means the beginning. */
export function resumePosition(p: Progress | undefined): number {
  if (!p || p.completed || p.position_seconds < RESUME_MIN_SECONDS) return 0;
  if (p.duration_seconds && p.position_seconds > p.duration_seconds - RESUME_END_MARGIN_SECONDS) return 0;
  return p.position_seconds;
}

export function isCompleted(position: number, duration: number): boolean {
  return duration > 0 && position >= COMPLETED_RATIO * duration;
}

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * PUT /me/progress through the web proxy. `keepalive` lets the request outlive the page when the
 * tab closes, which the generated client can't ask for. Failures are ignored: the next save
 * catches up.
 */
export function saveProgress(animeId: number, episode: number, body: ProgressIn, keepalive = false) {
  return fetch(`/api/proxy/me/progress/${animeId}/${episode}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  })
    .then(drain)
    .catch(() => undefined);
}
