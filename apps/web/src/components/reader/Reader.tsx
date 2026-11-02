"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRouter } from "@/i18n/navigation";
import {
  defaultReading,
  mangaHref,
  progressKey,
  readHref,
  type Chapter,
  type Direction,
  type ReadMode,
} from "@/lib/manga";

import { EndCard } from "./EndCard";
import { clampPage, swipeStep, zoneOf } from "./navigation";
import { PageView } from "./PageView";
import { ReaderBars } from "./ReaderBars";
import { useReadingSettings } from "./settings";
import { StripView } from "./StripView";
import { useReaderKeys } from "./useReaderKeys";
import { useReadProgress } from "./useReadProgress";

export type ReaderProps = {
  mangaId: number;
  source: string;
  title: string;
  mediaType: string | null | undefined;
  chapter: Chapter;
  previous: Chapter | null;
  next: Chapter | null;
  /** Page image URLs, already pointing at the web server's proxy. */
  pages: string[];
  startPage: number;
  lang: string | null;
};

// The bars go away on their own after the chapter opens, so the first page is seen whole.
const AUTO_HIDE_MS = 2500;

/**
 * The reader. One page at a time (buttons, keys, taps on the sides, swipes) or the whole
 * chapter as a strip to scroll down. The bars hide on a tap in the middle. The mode and the
 * direction are remembered per title on this device; the page is saved to the account.
 */
export function Reader({ mangaId, source, title, mediaType, chapter, previous, next, pages, startPage, lang }: ReaderProps) {
  const t = useTranslations("reader");
  const router = useRouter();
  const defaults = useMemo(() => defaultReading(mediaType), [mediaType]);
  const [settings, update] = useReadingSettings(mangaId, defaults);
  const [page, setPage] = useState(() => clampPage(startPage, pages.length));
  const [shown, setShown] = useState(true);
  const [ended, setEnded] = useState(false);
  const [bars, setBars] = useState({ top: 0, bottom: 0 });
  const touch = useRef<{ x: number; y: number } | null>(null);
  const count = pages.length;

  useEffect(() => {
    const timer = setTimeout(() => setShown(false), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, []);

  useReadProgress(mangaId, progressKey(chapter), page, count);

  const goTo = useCallback(
    (index: number) => {
      setEnded(false);
      setPage(clampPage(index, count));
    },
    [count],
  );

  const step = useCallback(
    (delta: -1 | 1) => {
      if (ended) {
        if (delta < 0) setEnded(false);
        return;
      }
      if (delta > 0 && page >= count - 1) {
        setEnded(true);
        setShown(true);
        return;
      }
      goTo(page + delta);
    },
    [ended, page, count, goTo],
  );

  const leave = useCallback(() => router.push(mangaHref(mangaId)), [router, mangaId]);
  const toggle = useCallback(() => setShown((s) => !s), []);
  const onHeights = useCallback((top: number, bottom: number) => setBars({ top, bottom }), []);
  const first = useCallback(() => goTo(0), [goTo]);
  const last = useCallback(() => goTo(count - 1), [goTo, count]);

  useReaderKeys(settings.direction, settings.mode === "page", { step, first, last, leave, toggleControls: toggle });

  // Preload the next two pages, so a page turn never waits.
  useEffect(() => {
    if (settings.mode !== "page") return;
    const ahead = pages.slice(page + 1, page + 3).map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
    return () => ahead.forEach((img) => (img.src = ""));
  }, [pages, page, settings.mode]);

  function onTap(e: React.MouseEvent<HTMLDivElement>) {
    if (settings.mode !== "page") {
      toggle();
      return;
    }
    const zone = zoneOf(e.clientX / e.currentTarget.clientWidth, settings.direction);
    if (zone === "toggle") toggle();
    else step(zone === "forward" ? 1 : -1);
  }

  function onTouchStart(e: React.TouchEvent) {
    const point = e.touches[0];
    touch.current = { x: point.clientX, y: point.clientY };
  }

  function onTouchEnd(e: React.TouchEvent) {
    const start = touch.current;
    touch.current = null;
    if (!start || settings.mode !== "page") return;
    const end = e.changedTouches[0];
    const delta = swipeStep(end.clientX - start.x, end.clientY - start.y, settings.direction);
    if (delta !== 0) step(delta);
  }

  const chapterHref = (target: Chapter) => readHref(source, mangaId, target.id, lang);
  const end = <EndCard title={title} next={next} nextHref={next ? chapterHref(next) : null} titleHref={mangaHref(mangaId)} />;

  return (
    <div className="fixed inset-0 z-[60] select-none bg-[#0d0719] text-fg" data-mode={settings.mode}>
      <div
        // With the bars up, a single page fits between them; the strip runs under them.
        className="absolute inset-0 transition-[padding] duration-200"
        style={shown && settings.mode === "page" ? { paddingTop: bars.top, paddingBottom: bars.bottom } : undefined}
        onClick={onTap}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        role="presentation"
      >
        {settings.mode === "page" ? (
          <PageView src={pages[page]} page={page} chapterEnd={ended ? end : null} />
        ) : (
          <StripView pages={pages} page={page} startPage={startPage} onPageChange={setPage} chapterEnd={end} />
        )}
      </div>
      <ReaderBars
        shown={shown}
        title={title}
        titleHref={mangaHref(mangaId)}
        chapter={chapter}
        page={page}
        count={count}
        mode={settings.mode}
        direction={settings.direction}
        previousHref={previous ? chapterHref(previous) : null}
        nextHref={next ? chapterHref(next) : null}
        onPage={goTo}
        onMode={(mode: ReadMode) => update({ mode })}
        onDirection={(direction: Direction) => update({ direction })}
        onToggle={toggle}
        onHeights={onHeights}
        hideLabel={t("hideControls")}
        showLabel={t("showControls")}
      />
    </div>
  );
}
