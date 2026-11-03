"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { Link } from "@/i18n/navigation";
import type { Chapter, Direction, ReadMode } from "@/lib/manga";

type Props = {
  shown: boolean;
  title: string;
  titleHref: string;
  chapter: Chapter;
  page: number;
  count: number;
  mode: ReadMode;
  direction: Direction;
  previousHref: string | null;
  nextHref: string | null;
  onPage: (index: number) => void;
  onMode: (mode: ReadMode) => void;
  onDirection: (direction: Direction) => void;
  onToggle: () => void;
  /** Told the bars' real heights, so a page can be fitted between them. */
  onHeights: (top: number, bottom: number) => void;
  hideLabel: string;
  showLabel: string;
};

const bar = "absolute inset-x-0 z-10 flex items-center gap-3 border-line bg-bg px-3 transition-transform duration-200 sm:px-5";
const icon = "press flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg hover:border-accent disabled:opacity-30 disabled:hover:border-line-strong";
const segment = (active: boolean) =>
  `press flex min-h-8 items-center rounded-full px-3 text-[13px] font-bold leading-none ${active ? "bg-accent text-on-accent" : "text-muted hover:text-fg"}`;

function Chevron({ left }: { left?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={left ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}

/** The flat bars above and below the pages: where you are, the page slider, the mode and the chapter links. */
export function ReaderBars({ shown, title, titleHref, chapter, page, count, mode, direction, previousHref, nextHref, onPage, onMode, onDirection, onToggle, onHeights, hideLabel, showLabel }: Props) {
  const t = useTranslations("reader");
  const label = chapter.number ? t("chapter", { n: chapter.number }) : t("oneShot");
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // The bottom bar's height depends on the controls it shows and the safe area: measure it.
  useEffect(() => {
    const report = () => onHeights(top.current?.offsetHeight ?? 0, bottom.current?.offsetHeight ?? 0);
    report();
    const observer = new ResizeObserver(report);
    if (top.current) observer.observe(top.current);
    if (bottom.current) observer.observe(bottom.current);
    return () => observer.disconnect();
  }, [onHeights]);

  return (
    <div aria-label={t("controls")} role="group" onClick={stop} onTouchStart={stop} onTouchEnd={stop} className="contents">
      <div
        ref={top}
        className={`${bar} top-0 h-[calc(3.5rem+env(safe-area-inset-top))] border-b pt-[env(safe-area-inset-top)] ${shown ? "" : "-translate-y-full"}`}
        aria-hidden={!shown}
      >
        <Link href={titleHref} aria-label={t("back", { title })} className={icon} tabIndex={shown ? 0 : -1}>
          <Chevron left />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{title}</p>
          <p className="truncate text-xs text-muted">
            {label}
            {chapter.title ? ` · ${chapter.title}` : ""}
          </p>
        </div>
        <p className="shrink-0 text-sm tabular-nums text-muted">
          {page + 1} / {count}
        </p>
        <button type="button" onClick={onToggle} aria-label={hideLabel} className={`${icon} hidden md:flex`} tabIndex={shown ? 0 : -1}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div
        ref={bottom}
        className={`${bar} bottom-0 flex-col items-stretch gap-2 border-t py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] ${shown ? "" : "translate-y-full"}`}
        aria-hidden={!shown}
      >
        <label className="flex items-center gap-3 text-xs tabular-nums text-muted">
          <span className="sr-only">{t("page")}</span>
          <input
            type="range"
            min={0}
            max={Math.max(count - 1, 0)}
            value={page}
            dir={mode === "page" && direction === "rtl" ? "rtl" : "ltr"}
            onChange={(e) => onPage(Number(e.target.value))}
            aria-valuetext={t("pageOf", { page: page + 1, pages: count })}
            className="h-11 w-full accent-accent"
            tabIndex={shown ? 0 : -1}
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          {previousHref ? (
            <Link href={previousHref} aria-label={t("previousChapter")} className={icon} tabIndex={shown ? 0 : -1}>
              <Chevron left />
            </Link>
          ) : (
            <span aria-hidden="true" className={`${icon} opacity-30`} />
          )}
          <div className="flex items-center gap-2">
            <div role="group" aria-label={t("mode.label")} className="flex rounded-full border border-line-strong p-[3px]">
              {(["page", "strip"] as const).map((m) => (
                <button key={m} type="button" onClick={() => onMode(m)} aria-pressed={mode === m} className={segment(mode === m)} tabIndex={shown ? 0 : -1}>
                  {t(`mode.${m}`)}
                </button>
              ))}
            </div>
            {mode === "page" && (
              <button
                type="button"
                onClick={() => onDirection(direction === "rtl" ? "ltr" : "rtl")}
                aria-label={t("direction.label")}
                title={t(`direction.${direction}`)}
                className="press flex min-h-9 items-center gap-1 rounded-full border border-line-strong px-3 text-[13px] font-bold text-fg hover:border-accent"
                tabIndex={shown ? 0 : -1}
              >
                <span aria-hidden="true">{direction === "rtl" ? "←" : "→"}</span>
                <span className="sr-only sm:not-sr-only">{t(`direction.${direction}`)}</span>
              </button>
            )}
          </div>
          {nextHref ? (
            <Link href={nextHref} aria-label={t("nextChapter")} className={icon} tabIndex={shown ? 0 : -1}>
              <Chevron />
            </Link>
          ) : (
            <span aria-hidden="true" className={`${icon} opacity-30`} />
          )}
        </div>
      </div>
      {!shown && (
        // The way out stays on screen while the bars are away: an installed iPhone app has no browser back.
        <Link
          href={titleHref}
          aria-label={t("back", { title })}
          className="press absolute left-[calc(0.75rem+env(safe-area-inset-left))] top-[calc(0.75rem+env(safe-area-inset-top))] z-10 flex h-11 w-11 items-center justify-center rounded-full border border-line-strong bg-bg/80 text-fg hover:border-accent"
        >
          <Chevron left />
        </Link>
      )}
      {!shown && <button type="button" onClick={onToggle} className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-20">{showLabel}</button>}
    </div>
  );
}
