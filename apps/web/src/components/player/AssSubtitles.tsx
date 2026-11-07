"use client";

import { useEffect, useRef, type RefObject } from "react";

type Props = {
  video: RefObject<HTMLVideoElement | null>;
  /** The styled (ASS) track to draw, through the API proxy. */
  url: string;
  /** Font name (lower case) -> link, through the API proxy. Loaded only when the script uses one. */
  fonts: Record<string, string>;
  /** Called when the renderer can't run here; the player then shows the plain WebVTT copy. */
  onFail: () => void;
  /** Cap libass's caches, for a device short on memory (the TV). */
  lowMemory?: boolean;
};

/**
 * libass's caches on a TV: the rendered-bitmap cache in MiB and the glyph cache in glyphs.
 * Left at 0, libass uses its desktop-sized defaults, and the worker's WebAssembly memory only
 * ever grows, so a long episode with heavy typesetting can take a lot of a TV's memory.
 */
export const TV_LIBASS_LIMITS = { libassMemoryLimit: 48, libassGlyphLimit: 2000 } as const;

/** How often, and for how many checks in a row, a draw may stay unfinished while the video plays. */
const WATCH_MS = 2000;
const STUCK_CHECKS = 3;

/**
 * Draws ASS subtitles as their authors styled them (positions, signs, karaoke, embedded fonts)
 * with JASSUB, libass compiled to WebAssembly. The canvas sits over the video. Safari's
 * native full screen can't show it; the WebVTT track takes over there (see SubtitleOverlay).
 */
export function AssSubtitles({ video, url, fonts, onFail, lowMemory = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fail = useRef(onFail);
  useEffect(() => {
    fail.current = onFail;
  }, [onFail]);

  useEffect(() => {
    const v = video.current;
    const box = host.current;
    if (!v || !box) return;
    // A canvas can hand its drawing over to a worker only once, so each track gets a new one.
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    box.appendChild(canvas);
    let renderer: import("jassub").default | undefined;
    let cancelled = false;
    let watch: ReturnType<typeof setInterval> | undefined;
    // The renderer can also die or hang mid-episode (out of memory, say); it then just stops
    // drawing. Hand over to the plain copy once, so the viewer keeps subtitles.
    const died = () => {
      if (cancelled) return;
      cancelled = true;
      clearInterval(watch);
      // A hung worker never answers destroy(), so stop it here and free its memory now.
      renderer?._worker.terminate();
      fail.current();
    };
    void (async () => {
      const [{ default: JASSUB }, script] = await Promise.all([
        import("jassub"),
        fetch(url).then((r) => {
          if (!r.ok) throw new Error(`subtitles answered ${r.status}`);
          return r.text();
        }),
      ]);
      if (cancelled) return;
      // The worker resolves links against its own script, so they must be absolute.
      const availableFonts = Object.fromEntries(
        Object.entries(fonts).map(([name, link]) => [name, new URL(link, window.location.href).href]),
      );
      const r = new JASSUB({
        video: v,
        canvas,
        subContent: script,
        availableFonts,
        ...(lowMemory ? TV_LIBASS_LIMITS : {}),
      });
      renderer = r;
      r._worker.addEventListener("error", died);
      r._worker.addEventListener("messageerror", died);
      await r.ready;
      if (cancelled) return;
      let stuck = 0;
      watch = setInterval(() => {
        stuck = r.busy && !v.paused ? stuck + 1 : 0;
        if (stuck >= STUCK_CHECKS) died();
      }, WATCH_MS);
      // It draws on each new video frame; a paused video has none coming, so draw once now.
      if (!cancelled && v.paused && v.videoWidth > 0) {
        const frame = { mediaTime: v.currentTime, width: v.videoWidth, height: v.videoHeight };
        await r.manualRender({ ...frame, expectedDisplayTime: performance.now() });
      }
    })().catch(died);
    return () => {
      cancelled = true;
      clearInterval(watch);
      void renderer?.destroy().catch(() => undefined);
      canvas.remove();
    };
  }, [video, url, fonts, lowMemory]);

  return <div ref={host} aria-hidden="true" data-testid="ass-subtitles" className="pointer-events-none absolute inset-0" />;
}
