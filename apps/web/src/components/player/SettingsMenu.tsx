"use client";

import { useTranslations } from "next-intl";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { BottomSheet } from "@/components/ui/BottomSheet";

import { BACKGROUNDS, COLORS, POSITIONS, SIZES, type SubtitleStyle } from "./subtitleStyle";

export type Quality = { index: number; height: number };
export type AudioTrack = { id: number; label: string; lang?: string };

type Props = {
  qualities: Quality[];
  /** -1 for automatic. */
  quality: number;
  onQuality: (index: number) => void;
  /** Tracks inside the stream (HLS). */
  audioTracks: AudioTrack[];
  audioTrack: number;
  onAudioTrack: (id: number) => void;
  /** Labels of the sources (each with its sub or dub) that have this episode. Picking one
   * reloads the episode from there. Empty when the viewer can't switch, e.g. a room guest. */
  streams: string[];
  /** The one playing, or -1. */
  stream: number;
  onStream: (index: number) => void;
  /** Label of what is playing now. */
  streamName: string;
  /** Names already localized, in the same order as the tracks. */
  subtitleNames: string[];
  /** -1 for off. */
  subtitle: number;
  onSubtitle: (index: number) => void;
  speeds: number[];
  rate: number;
  onRate: (rate: number) => void;
  style: SubtitleStyle;
  onStyle: (style: SubtitleStyle) => void;
  onClose: () => void;
};

type View = "main" | "source" | "audio" | "subtitles" | "speed" | "quality" | "style";

function Row({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-12 w-full items-center justify-between gap-4 rounded-ui px-3 text-left text-sm hover:bg-white/10 active:bg-white/10"
    >
      <span>{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-right text-muted">
        <span className="min-w-0 break-words">{value}</span>
        <span aria-hidden="true">›</span>
      </span>
    </button>
  );
}

function Option({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 rounded-ui px-3 text-left text-sm hover:bg-white/10 active:bg-white/10"
    >
      <span aria-hidden="true" className={`w-4 text-accent ${checked ? "" : "invisible"}`}>
        ✓
      </span>
      <span className="min-w-0">{children}</span>
    </button>
  );
}

function Chips<T extends string>({
  label,
  values,
  value,
  name,
  onPick,
}: {
  label: string;
  values: readonly T[];
  value: T;
  name: (v: T) => string;
  onPick: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="px-3 py-2">
      <p className="text-xs font-bold uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            onClick={() => onPick(v)}
            className={`press min-h-11 rounded-full border px-4 text-sm ${
              v === value ? "border-accent bg-accent/20 text-fg" : "border-line-strong text-muted hover:text-fg"
            }`}
          >
            {name(v)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsMenu(props: Props) {
  const t = useTranslations("player");
  const [view, setView] = useState<View>("main");
  const { style, onStyle } = props;
  const set = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) => onStyle({ ...style, [key]: value });

  const hasSubtitles = props.subtitleNames.length > 0;
  const hasAudioTracks = props.audioTracks.length > 1;
  const audioName = props.audioTracks.find((a) => a.id === props.audioTrack)?.label;
  const subtitleName = props.subtitle < 0 ? t("subtitlesOff") : props.subtitleNames[props.subtitle];
  const qualityName = props.quality < 0 ? t("settings.auto") : t("settings.height", { height: heightOf(props) });
  const titles: Record<View, string> = {
    main: t("settings.title"),
    source: t("source"),
    audio: t("audio"),
    subtitles: t("subtitles"),
    speed: t("speed"),
    quality: t("settings.quality"),
    style: t("settings.subtitleStyle"),
  };
  const back = () => setView("main");

  let body: ReactNode;
  switch (view) {
    case "source":
      body = (
        <div role="radiogroup" aria-label={titles.source}>
          {props.streams.map((label, i) => (
            <Option key={i} checked={props.stream === i} onClick={() => props.onStream(i)}>
              {label}
            </Option>
          ))}
        </div>
      );
      break;
    case "audio":
      body = (
        <div role="radiogroup" aria-label={titles.audio}>
          {props.audioTracks.map((a) => (
            <Option key={a.id} checked={a.id === props.audioTrack} onClick={() => props.onAudioTrack(a.id)}>
              {a.label}
            </Option>
          ))}
        </div>
      );
      break;
    case "subtitles":
      body = (
        <div role="radiogroup" aria-label={titles.subtitles}>
          <Option checked={props.subtitle < 0} onClick={() => props.onSubtitle(-1)}>
            {t("subtitlesOff")}
          </Option>
          {props.subtitleNames.map((name, i) => (
            // Names can repeat only if the source sends the same label twice, so the index is the key.
            <Option key={i} checked={props.subtitle === i} onClick={() => props.onSubtitle(i)}>
              {name}
            </Option>
          ))}
          <div className="mt-1 border-t border-line pt-1">
            <Row label={t("settings.subtitleStyle")} value="" onClick={() => setView("style")} />
          </div>
        </div>
      );
      break;
    case "speed":
      body = (
        <div role="radiogroup" aria-label={titles.speed}>
          {props.speeds.map((s) => (
            <Option key={s} checked={s === props.rate} onClick={() => props.onRate(s)}>
              {t("speedValue", { rate: s })}
            </Option>
          ))}
        </div>
      );
      break;
    case "quality":
      body = (
        <div role="radiogroup" aria-label={titles.quality}>
          <Option checked={props.quality < 0} onClick={() => props.onQuality(-1)}>
            {t("settings.auto")}
          </Option>
          {props.qualities.map((q) => (
            <Option key={q.index} checked={q.index === props.quality} onClick={() => props.onQuality(q.index)}>
              {t("settings.height", { height: q.height })}
            </Option>
          ))}
        </div>
      );
      break;
    case "style":
      body = (
        <>
          <Chips label={t("settings.size")} values={SIZES} value={style.subtitle_size} name={(v) => t(`settings.sizes.${v}`)} onPick={(v) => set("subtitle_size", v)} />
          <Chips label={t("settings.color")} values={COLORS} value={style.subtitle_color} name={(v) => t(`settings.colors.${v}`)} onPick={(v) => set("subtitle_color", v)} />
          <Chips label={t("settings.background")} values={BACKGROUNDS} value={style.subtitle_background} name={(v) => t(`settings.backgrounds.${v}`)} onPick={(v) => set("subtitle_background", v)} />
          <Chips label={t("settings.position")} values={POSITIONS} value={style.subtitle_position} name={(v) => t(`settings.positions.${v}`)} onPick={(v) => set("subtitle_position", v)} />
        </>
      );
      break;
    default:
      body = (
        <>
          {props.streams.length > 1 && <Row label={t("source")} value={props.streamName} onClick={() => setView("source")} />}
          {hasAudioTracks && <Row label={t("audio")} value={audioName ?? ""} onClick={() => setView("audio")} />}
          {hasSubtitles && <Row label={t("subtitles")} value={subtitleName} onClick={() => setView("subtitles")} />}
          <Row label={t("speed")} value={t("speedValue", { rate: props.rate })} onClick={() => setView("speed")} />
          {props.qualities.length > 1 && <Row label={t("settings.quality")} value={qualityName} onClick={() => setView("quality")} />}
        </>
      );
  }

  // Escape in a sub-view steps back to the main list first; only the main list lets it close the menu.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || view === "main") return;
    e.stopPropagation();
    back();
  }

  return (
    <BottomSheet
      label={t("settings.title")}
      onClose={props.onClose}
      className="fixed inset-x-0 bottom-0 z-10 flex max-h-[75dvh] flex-col rounded-t-2xl border border-line bg-surface pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-lg shadow-black/50 sm:absolute sm:inset-x-auto sm:bottom-28 sm:right-8 sm:w-80 sm:origin-bottom-right sm:rounded-ui"
    >
      {({ dismiss, handleProps }) => (
        <div onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
          <div {...handleProps} className={`px-2 pt-2 ${handleProps.className}`}>
            <span aria-hidden="true" className="mx-auto mb-1 block h-1 w-10 rounded-full bg-line-strong sm:hidden" />
            <div className="flex items-center gap-1 pb-1">
              {view !== "main" ? (
                <button
                  type="button"
                  onClick={back}
                  aria-label={t("settings.back")}
                  className="press flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10 active:bg-white/10"
                >
                  <span aria-hidden="true">‹</span>
                </button>
              ) : null}
              <p className="flex-1 truncate px-2 font-bold">{titles[view]}</p>
              <button
                type="button"
                onClick={dismiss}
                aria-label={t("settings.close")}
                className="press flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10 active:bg-white/10"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain px-2">{body}</div>
        </div>
      )}
    </BottomSheet>
  );
}

function heightOf(props: Props) {
  return props.qualities.find((q) => q.index === props.quality)?.height ?? 0;
}
