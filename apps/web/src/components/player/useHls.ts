"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { capLevel, levelsToDrop, qualityList } from "./qualities";
import type { AudioTrack, Quality } from "./SettingsMenu";

/**
 * The audio track matching the wanted one (by name or language), else the one the stream marks as
 * its default, else the first. A master may list its tracks in any order (one starts with Hindi),
 * so the first is only the last resort.
 */
export function pickAudio(
  tracks: { id: number; name: string; lang?: string; default?: boolean }[],
  wanted: string | null,
): number {
  const target = wanted?.toLowerCase();
  const match = target
    ? tracks.find((a) => a.name.toLowerCase() === target || a.lang?.toLowerCase() === target)
    : undefined;
  return (match ?? tracks.find((a) => a.default) ?? tracks[0])?.id ?? -1;
}

/**
 * The audio tracks to offer: one per name and language. Some hosts list the same track once for
 * every quality, which would show the viewer the same language several times.
 */
export function uniqueAudio<T extends { name: string; lang?: string }>(tracks: T[]): T[] {
  const seen = new Set<string>();
  return tracks.filter((a) => {
    const key = `${a.name}\u0000${a.lang ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Buffering for streams that come through our proxy from far-away hosts: the first segment is
 * asked for while the manifest is still being parsed, a minute is kept ahead so a pause or a
 * short stall never empties the buffer, and only half a minute is kept behind, to spare memory
 * on phones.
 */
export const HLS_CONFIG = {
  startFragPrefetch: true,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  backBufferLength: 30,
} as const;

/**
 * Whether this device already failed to decode an HEVC original. Kept for the whole visit, so
 * every later episode starts on the H.264 copy instead of failing and retrying again.
 */
export const hevcSupport = { failed: false };

type Options = {
  video: RefObject<HTMLVideoElement | null>;
  url: string | null;
  kind: string;
  defaultAudio: string | null;
  /** The tallest quality the viewer asked for; automatic quality stays within it. */
  maxHeight?: number | null;
  /** Called to ask for the stream again, after the original HEVC failed to decode. */
  onRetry: () => void;
  onFail: () => void;
};

/**
 * Plays an HLS stream: hls.js wherever it works (one code path, so tracks behave the same),
 * native HLS only where it can't run, e.g. iPhone Safari. Also owns the quality and audio
 * choices, and the retry with H.264 when this device can't decode the original HEVC.
 */
export function useHls({ video, url, kind, defaultAudio, maxHeight = null, onRetry, onFail }: Options) {
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const hevcUsed = useRef(false);
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [quality, setQuality] = useState(-1);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);

  useEffect(() => {
    const v = video.current;
    if (!v || !url || kind !== "hls") return;
    let hls: import("hls.js").default | undefined;
    let cancelled = false;
    void import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (Hls.isSupported()) {
        let recovered = false;
        hls = new Hls(HLS_CONFIG);
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          // Play the original HEVC when this device decodes it; if it then fails, retry with H.264.
          if (!hevcSupport.failed) {
            const drop = levelsToDrop(data.levels);
            hevcUsed.current = drop.length > 0;
            for (const i of drop.reverse()) hls?.removeLevel(i);
          }
          const levels = hls?.levels ?? data.levels;
          setQualities(qualityList(levels));
          const cap = capLevel(levels, maxHeight);
          if (hls && cap >= 0) hls.autoLevelCapping = cap;
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
          const found = uniqueAudio(
            data.audioTracks.map((a) => ({ id: a.id, name: a.name, lang: a.lang, default: a.default })),
          );
          setAudioTracks(found.map((a) => ({ id: a.id, label: a.name || a.lang || String(a.id + 1), lang: a.lang })));
          const id = pickAudio(found, defaultAudio);
          if (hls && id >= 0 && hls.audioTrack !== id) hls.audioTrack = id;
          setAudioTrack(id);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          // Only a decoding failure means the HEVC can't play here; a network error is the
          // host's fault and must not drop everyone to the H.264 copy.
          const media = data.type === Hls.ErrorTypes.MEDIA_ERROR;
          if (media && hevcUsed.current) {
            hevcUsed.current = false;
            hevcSupport.failed = true;
            onRetry();
          } else if (media && !recovered) {
            recovered = true;
            hls?.recoverMediaError();
          } else onFail();
        });
        hls.loadSource(url);
        hls.attachMedia(v);
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = url;
      } else onFail();
    });
    return () => {
      cancelled = true;
      hls?.destroy();
      hlsRef.current = null;
      setQualities([]);
      setQuality(-1);
      setAudioTracks([]);
    };
    // defaultAudio arrives with the url, in the same response; the callbacks only call setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind]);

  const chooseQuality = useCallback((index: number) => {
    setQuality(index);
    // nextLevel switches at the next segment, keeping what is buffered instead of flushing it.
    if (hlsRef.current) hlsRef.current.nextLevel = index;
  }, []);

  const chooseAudio = useCallback((id: number) => {
    setAudioTrack(id);
    if (hlsRef.current) hlsRef.current.audioTrack = id;
  }, []);

  return { qualities, quality, chooseQuality, audioTracks, audioTrack, chooseAudio };
}
