"use client";

import { useEffect, useState, type RefObject } from "react";

import { blockPosition, cueStyle, cueText, type SubtitleStyle } from "./subtitleStyle";

/** Safari's own full screen for a <video>; the only kind iPhone has. */
export type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

type Props = {
  video: RefObject<HTMLVideoElement | null>;
  /** Index of the <track> element to show, or -1 for none. */
  selected: number;
  /** Changes when the <track> elements are replaced. */
  tracksKey: string;
  style: SubtitleStyle;
  controlsShown: boolean;
  /** False while the track is drawn styled by AssSubtitles: only native full screen uses it then. */
  draw?: boolean;
  /** Room the controls take at the bottom while shown (see blockPosition). */
  controlsHeight?: string;
};

/**
 * Draws the chosen subtitle track ourselves instead of the browser's cue box, so size,
 * colour, background and position look the same everywhere. The track stays "hidden" (cues
 * load, nothing is drawn natively) and every other track is disabled. In Safari's native
 * full screen our overlay is not shown, so the track is switched to "showing" until it ends.
 */
export function SubtitleOverlay({ video, selected, tracksKey, style, controlsShown, draw = true, controlsHeight }: Props) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const elements = [...v.querySelectorAll("track")];
    let native = false;
    const apply = () =>
      elements.forEach((el, i) => {
        el.track.mode = i === selected ? (native ? "showing" : "hidden") : "disabled";
      });
    const toggleNative = (on: boolean) => () => {
      native = on;
      apply();
    };
    const begin = toggleNative(true);
    const end = toggleNative(false);
    apply();
    // hls.js may add text tracks of its own; keep ours in the state we chose.
    v.textTracks.addEventListener("addtrack", apply);
    v.addEventListener("webkitbeginfullscreen", begin);
    v.addEventListener("webkitendfullscreen", end);
    const track = elements[selected]?.track;
    const update = () => {
      const cues = track?.activeCues ? [...track.activeCues] : [];
      setLines(cues.flatMap((cue) => cueText((cue as VTTCue).text ?? "").split("\n")).filter(Boolean));
    };
    update();
    track?.addEventListener("cuechange", update);
    return () => {
      v.textTracks.removeEventListener("addtrack", apply);
      v.removeEventListener("webkitbeginfullscreen", begin);
      v.removeEventListener("webkitendfullscreen", end);
      track?.removeEventListener("cuechange", update);
    };
  }, [video, selected, tracksKey]);

  if (!draw || selected < 0 || lines.length === 0) return null;
  return (
    <div
      data-testid="subtitles"
      aria-live="off"
      className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1 px-[6%] text-center transition-[bottom] duration-300"
      style={blockPosition(style.subtitle_position, controlsShown, controlsHeight)}
    >
      {lines.map((line, i) => (
        <span key={i} className="whitespace-pre-wrap rounded-sm px-2 font-medium leading-snug" style={cueStyle(style)}>
          {line}
        </span>
      ))}
    </div>
  );
}
