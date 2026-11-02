"use client";

import { useTranslations } from "next-intl";

import { PlayerIcon } from "./icons";
import { formatTime } from "./progress";
import { SEEK_STEP } from "./usePlayerKeys";

export const iconButton =
  "press flex h-11 w-11 items-center justify-center rounded-full text-fg hover:bg-white/10 active:bg-white/10";

type Props = {
  current: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  volume: number;
  fullscreen: boolean;
  settingsOpen: boolean;
  hasNext: boolean;
  onSeekTo: (seconds: number) => void;
  onTogglePlay: () => void;
  onSeekBy: (delta: number) => void;
  onToggleMute: () => void;
  onVolume: (volume: number) => void;
  onToggleSettings: () => void;
  onNext: () => void;
  onToggleFullscreen: () => void;
};

/** The seek bar and the buttons under it. */
export function ControlBar(props: Props) {
  const { current, duration, playing, muted, volume, fullscreen, settingsOpen, hasNext } = props;
  const t = useTranslations("player");
  // Until the stream says how long it is, "0:00 / 0:00" reads as frozen: keep the row's
  // space so nothing moves, but show it only once the length is known.
  const known = Number.isFinite(duration) && duration > 0;
  return (
    <div className="pointer-events-auto bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-10 sm:px-8">
      <div
        aria-hidden={!known}
        className={`flex items-center gap-3 text-xs tabular-nums text-muted ${known ? "" : "invisible"}`}
      >
        <span>{formatTime(current)}</span>
        <input
          type="range"
          aria-label={t("seek")}
          aria-valuetext={`${formatTime(current)} / ${formatTime(duration)}`}
          min={0}
          max={duration || 0}
          step={1}
          value={Math.min(current, duration || 0)}
          onChange={(e) => props.onSeekTo(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-accent"
        />
        <span>{formatTime(duration)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 sm:gap-2">
        <button type="button" onClick={props.onTogglePlay} aria-label={playing ? t("pause") : t("play")} className={iconButton}>
          <PlayerIcon name={playing ? "pause" : "play"} />
        </button>
        <button type="button" onClick={() => props.onSeekBy(-SEEK_STEP)} aria-label={t("rewind")} className={iconButton}>
          <PlayerIcon name="rewind" />
        </button>
        <button type="button" onClick={() => props.onSeekBy(SEEK_STEP)} aria-label={t("forward")} className={iconButton}>
          <PlayerIcon name="forward" />
        </button>
        <button
          type="button"
          onClick={props.onToggleMute}
          aria-label={muted ? t("unmute") : t("mute")}
          className={iconButton}
        >
          <PlayerIcon name={muted || volume === 0 ? "muted" : "volume"} />
        </button>
        <input
          type="range"
          aria-label={t("volume")}
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => props.onVolume(Number(e.target.value))}
          className="hidden w-24 cursor-pointer accent-accent sm:block"
        />
        <span className="flex-1" />
        <button
          type="button"
          onClick={props.onToggleSettings}
          aria-label={t("settings.title")}
          aria-expanded={settingsOpen}
          className={iconButton}
        >
          <PlayerIcon name="settings" />
        </button>
        {hasNext && (
          <button
            type="button"
            onClick={props.onNext}
            aria-label={t("next")}
            className="press flex h-11 items-center gap-2 rounded-full px-3 text-fg hover:bg-white/10 sm:px-4"
          >
            <PlayerIcon name="next" />
            <span className="hidden text-sm font-bold sm:inline">{t("nextShort")}</span>
          </button>
        )}
        <button
          type="button"
          onClick={props.onToggleFullscreen}
          aria-label={fullscreen ? t("exitFullscreen") : t("fullscreen")}
          className={iconButton}
        >
          <PlayerIcon name={fullscreen ? "exitFullscreen" : "fullscreen"} />
        </button>
      </div>
      <p className="sr-only">{t("shortcuts")}</p>
    </div>
  );
}
