"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

import { stageOf } from "./FullscreenStage";
import type { WebkitVideo } from "./SubtitleOverlay";

export function togglePlayback(v: HTMLVideoElement) {
  if (v.paused || v.ended) void v.play().catch(() => undefined);
  else v.pause();
}

/** Moves by `delta` seconds, staying inside the video. */
export function seekVideo(v: HTMLVideoElement, delta: number) {
  if (Number.isFinite(v.duration)) v.currentTime = Math.min(Math.max(v.currentTime + delta, 0), v.duration);
}

/** Changes the volume by `delta` (0 to 1), muting at zero. */
export function nudgeVolume(v: HTMLVideoElement, delta: number) {
  v.volume = Math.round(Math.min(Math.max(v.volume + delta, 0), 1) * 100) / 100;
  v.muted = v.volume === 0;
}

export function toggleMuted(v: HTMLVideoElement) {
  v.muted = !v.muted;
  if (!v.muted && v.volume === 0) v.volume = 0.5;
}

/** Leaves full screen, or puts the player stage (or, on iPhone, the video itself) in it. */
function switchFullscreen(stage: RefObject<HTMLDivElement | null>, video: RefObject<HTMLVideoElement | null>) {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  const el = stageOf(stage.current);
  if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
  // iPhone Safari can only full-screen a <video>, with its own controls and subtitles.
  else (video.current as WebkitVideo | null)?.webkitEnterFullscreen?.();
}

/** The actions on the <video> (play, seek, volume, mute, full screen) and the full-screen state. */
export function useVideoControls(
  video: RefObject<HTMLVideoElement | null>,
  stage: RefObject<HTMLDivElement | null>,
  ready: boolean,
) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setFullscreen(!!stage.current && document.fullscreenElement === stageOf(stage.current));
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [stage]);

  // Stable across renders, so the keyboard listener isn't added again on every time update.
  const togglePlay = useCallback(() => {
    const v = video.current;
    if (v && ready) togglePlayback(v);
  }, [video, ready]);

  const seekBy = useCallback(
    (delta: number) => {
      const v = video.current;
      if (v) seekVideo(v, delta);
    },
    [video],
  );

  const changeVolume = useCallback(
    (delta: number) => {
      const v = video.current;
      if (v) nudgeVolume(v, delta);
    },
    [video],
  );

  const toggleMute = useCallback(() => {
    const v = video.current;
    if (v) toggleMuted(v);
  }, [video]);

  const toggleFullscreen = useCallback(() => switchFullscreen(stage, video), [stage, video]);

  return { fullscreen, togglePlay, seekBy, changeVolume, toggleMute, toggleFullscreen };
}
