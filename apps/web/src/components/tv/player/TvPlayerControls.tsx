"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { PlayerIcon, type PlayerIconName } from "@/components/player/icons";
import { formatTime } from "@/components/player/progress";

import { setFocus } from "../spatial";
import { useTvFocus } from "../useTvFocus";

export const SEEK_KEY = "tvp-seek";
export const PLAY_KEY = "tvp-play";

type SeekBarProps = {
  current: number;
  duration: number;
  /** Where pending presses will land, or null. */
  target: number | null;
  onNudge: (direction: 1 | -1) => void;
  onEnter: () => void;
};

/**
 * The timeline. Focused, left and right move the target (shown as a second, brighter thumb with
 * its time above) and OK plays or pauses.
 */
export function TvSeekBar({ current, duration, target, onNudge, onEnter }: SeekBarProps) {
  const t = useTranslations("tv.player");
  const { ref, focused } = useTvFocus<HTMLDivElement>({
    focusKey: SEEK_KEY,
    remember: false,
    onEnter,
    onArrow: (direction) => {
      if (direction === "left" || direction === "right") {
        onNudge(direction === "right" ? 1 : -1);
        return false;
      }
      // Down always lands on play/pause, the first of the row, whatever is nearest.
      if (direction === "down") {
        setFocus(PLAY_KEY);
        return false;
      }
      return true;
    },
  });
  const known = duration > 0 && Number.isFinite(duration);
  const shown = target ?? current;
  const ratio = known ? Math.min(Math.max(shown / duration, 0), 1) : 0;
  const played = known ? Math.min(Math.max(current / duration, 0), 1) : 0;
  return (
    <div className="flex items-center gap-8">
      <span className="w-[7rem] shrink-0 text-[1.625rem] font-bold tabular-nums text-fg">{formatTime(shown)}</span>
      <div
        ref={ref}
        tabIndex={-1}
        role="slider"
        aria-label={t("timeline")}
        aria-valuemin={0}
        aria-valuemax={known ? Math.round(duration) : 0}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={t("timeOf", { time: formatTime(shown), total: formatTime(duration) })}
        className="relative flex-1 py-5 outline-none"
      >
        <div className={`relative w-full rounded-full bg-line-strong ${focused ? "h-3" : "h-2"}`}>
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${played * 100}%` }} />
          {target !== null && (
            <div className="absolute inset-y-0 rounded-full bg-fg" style={{ left: `${Math.min(played, ratio) * 100}%`, width: `${Math.abs(ratio - played) * 100}%` }} />
          )}
        </div>
        {focused && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-bg bg-fg"
            style={{ left: `${ratio * 100}%` }}
          />
        )}
        {target !== null && (
          <span
            aria-hidden="true"
            className="absolute bottom-full mb-1 -translate-x-1/2 rounded-full bg-fg px-4 py-1 text-[1.5rem] font-bold tabular-nums text-bg"
            style={{ left: `clamp(3rem, ${ratio * 100}%, calc(100% - 3rem))` }}
          >
            {formatTime(target)}
          </span>
        )}
      </div>
      <span className="w-[7rem] shrink-0 text-right text-[1.625rem] font-medium tabular-nums text-soft">
        {known ? `−${formatTime(duration - shown)}` : "–:––"}
      </span>
    </div>
  );
}

type ButtonProps = {
  focusKey: string;
  label: string;
  onPress: () => void;
  icon?: PlayerIconName;
  /** A round button with only the icon; the label is read out and shown under it when focused. */
  round?: boolean;
  children?: ReactNode;
};

/** A control on the player's bar: round with an icon, or a pill with text. */
export function TvControl({ focusKey, label, onPress, icon, round = false, children }: ButtonProps) {
  const { ref, focused } = useTvFocus<HTMLButtonElement>({ focusKey, onEnter: onPress, remember: false });
  // Solid even when not focused: the skip button sits on the picture, not on the card.
  const look = focused ? "border-accent bg-accent text-on-accent scale-[1.08]" : "border-line-strong bg-bg text-fg";
  return (
    <span className="relative inline-flex">
      <button
        ref={ref}
        type="button"
        aria-label={round ? label : undefined}
        onClick={onPress}
        className={`inline-flex min-h-[4.5rem] items-center justify-center gap-3 rounded-full border-2 text-[1.625rem] font-bold outline-none transition-transform duration-[160ms] ease-out [&_svg]:h-8 [&_svg]:w-8 ${
          round ? "w-[4.5rem]" : "px-8"
        } ${look}`}
      >
        {icon && <PlayerIcon name={icon} />}
        {!round && (children ?? label)}
      </button>
      {round && focused && (
        <span aria-hidden="true" className="absolute left-1/2 top-full mt-3 -translate-x-1/2 whitespace-nowrap text-[1.25rem] font-bold text-soft">
          {label}
        </span>
      )}
    </span>
  );
}
