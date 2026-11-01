"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { levelsToDrop, qualityList } from "./qualities";
import type { AudioTrack, Quality } from "./SettingsMenu";

/** The audio track matching the source's default (by name or language), else the first. */
export function pickAudio(tracks: { id: number; name: string; lang?: string }[], wanted: string | null): number {
  const target = wanted?.toLowerCase();
  const match = target && tracks.find((a) => a.name.toLowerCase() === target || a.lang?.toLowerCase() === target);
  return match ? match.id : (tracks[0]?.id ?? -1);
}

type Options = {
  video: RefObject<HTMLVideoElement | null>;
  url: string | null;
  kind: string;
  defaultAudio: string | null;
  /** Called to ask for the stream again, after the original HEVC failed to decode. */
  onRetry: () => void;
  onFail: () => void;
};

/**
 * Plays an HLS stream: hls.js wherever it works (one code path, so tracks behave the same),
 * native HLS only where it can't run, e.g. iPhone Safari. Also owns the quality and audio
 * choices, and the retry with H.264 when this device can't decode the original HEVC.
 */
export function useHls({ video, url, kind, defaultAudio, onRetry, onFail }: Options) {
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const hevcUsed = useRef(false);
  const hevcFailed = useRef(false);
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
        hls = new Hls();
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          // Play the original HEVC when this device decodes it; if it then fails, retry with H.264.
          if (!hevcFailed.current) {
            const drop = levelsToDrop(data.levels);
            hevcUsed.current = drop.length > 0;
            for (const i of drop.reverse()) hls?.removeLevel(i);
          }
          setQualities(qualityList(hls?.levels ?? data.levels));
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
          const found = data.audioTracks.map((a) => ({ id: a.id, name: a.name, lang: a.lang }));
          setAudioTracks(found.map((a) => ({ id: a.id, label: a.name || a.lang || String(a.id + 1), lang: a.lang })));
          const id = pickAudio(found, defaultAudio);
          if (hls && id >= 0 && hls.audioTrack !== id) hls.audioTrack = id;
          setAudioTrack(id);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (hevcUsed.current) {
            hevcUsed.current = false;
            hevcFailed.current = true;
            onRetry();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
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
    if (hlsRef.current) hlsRef.current.currentLevel = index;
  }, []);

  const chooseAudio = useCallback((id: number) => {
    setAudioTrack(id);
    if (hlsRef.current) hlsRef.current.audioTrack = id;
  }, []);

  return { qualities, quality, chooseQuality, audioTracks, audioTrack, chooseAudio };
}
