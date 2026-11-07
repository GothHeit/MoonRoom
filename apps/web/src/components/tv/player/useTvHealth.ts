"use client";

import type { components } from "@app/api-client";
import { useCallback, useEffect, useRef, type RefObject } from "react";

type TvHealth = components["schemas"]["TvHealthIn"];

export const HEALTH_INTERVAL_MS = 30_000;
const MAX_ERROR_KINDS = 12;
const MB = 1024 * 1024;

type Info = { source: string; animeId: number; episode: number; styled: boolean };

/** Seconds buffered ahead of and behind the playhead, and how many separate ranges there are. */
function bufferAround(v: HTMLVideoElement) {
  const at = v.currentTime;
  let ahead = 0;
  let behind = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    const start = v.buffered.start(i);
    const end = v.buffered.end(i);
    if (start <= at + 0.5 && end >= at) {
      ahead = Math.max(0, end - at);
      behind = Math.max(0, at - start);
    }
  }
  return { ahead, behind, ranges: v.buffered.length };
}

/** A health report of the TV player, as the API takes it. */
export function healthReport(v: HTMLVideoElement, info: Info, reason: string, errors: Record<string, number>): TvHealth {
  const { ahead, behind, ranges } = bufferAround(v);
  const quality = v.getVideoPlaybackQuality?.();
  // Chromium only; the TVs run Chromium.
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return {
    reason,
    source: info.source.replace(/[^\w.:/ -]/g, "").slice(0, 40),
    anime_id: info.animeId,
    episode: info.episode,
    uptime_s: performance.now() / 1000,
    position_s: v.currentTime || 0,
    buffered_ahead_s: ahead,
    buffered_behind_s: behind,
    buffered_ranges: ranges,
    ready_state: v.readyState,
    paused: v.paused,
    level_height: v.videoHeight,
    dropped_frames: quality?.droppedVideoFrames ?? 0,
    total_frames: quality?.totalVideoFrames ?? 0,
    js_heap_mb: memory ? memory.usedJSHeapSize / MB : 0,
    js_heap_limit_mb: memory ? memory.jsHeapSizeLimit / MB : 0,
    dom_nodes: document.getElementsByTagName("*").length,
    styled_subtitles: info.styled,
    errors,
  };
}

function send(body: TvHealth) {
  return fetch("/api/proxy/tv/health", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Every 30 s while an episode is open, and right away on a fatal player error, tells the API how
 * the TV is doing: memory, buffer, dropped frames and the player's errors since the last report.
 * Reports go to the server log only, to find out what grows before a TV hangs.
 */
export function useTvHealth(video: RefObject<HTMLVideoElement | null>, info: Info) {
  const errors = useRef<Record<string, number>>({});
  const latest = useRef(info);
  useEffect(() => {
    latest.current = info;
  });

  const report = useCallback(
    (reason: string) => {
      const v = video.current;
      if (!v) return;
      const body = healthReport(v, latest.current, reason, errors.current);
      errors.current = {};
      void send(body);
    },
    [video],
  );

  useEffect(() => {
    const timer = setInterval(() => report("tick"), HEALTH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [report]);

  /** Counts a player error by name; a fatal one is reported at once. */
  const onError = useCallback(
    (details: string, fatal: boolean) => {
      const name = details.replace(/[^\w.:/ -]/g, "").slice(0, 40) || "unknown";
      const counts = errors.current;
      if (name in counts || Object.keys(counts).length < MAX_ERROR_KINDS) counts[name] = (counts[name] ?? 0) + 1;
      if (fatal) report("error");
    },
    [report],
  );

  return { onError };
}
