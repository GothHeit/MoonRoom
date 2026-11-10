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

import { DroppedPrompt } from "@/components/player/DroppedPrompt";
import { useDroppedPrompt } from "@/components/player/useDroppedPrompt";

import { EndCard } from "./EndCard";
import { clampPage, type Zone } from "./navigation";
import { PagedView } from "./PagedView";
import { ReaderBars } from "./ReaderBars";
import { useReadingSettings } from "./settings";
import { StripView } from "./StripView";
import { useReaderKeys } from "./useReaderKeys";
import { useReadProgress } from "./useReadProgress";
import { useWakeLock } from "./useWakeLock";

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
 * The reader. One page at a time (buttons, keys, taps on the sides, swipes, pinch to zoom) or
 * the whole chapter as a strip to scroll down. The bars hide on a tap in the middle. The mode
 * and the direction are remembered per title on this device; the page is saved to the account.
 */
export function Reader({ mangaId, source, title, mediaType, chapter, previous, next, pages, startPage, lang }: ReaderProps) {
  const t = useTranslations("reader");
  const router = useRouter();
  const defaults = useMemo(() => defaultReading(mediaType), [mediaType]);
  const [settings, update] = useReadingSettings(mangaId, defaults);
  const count = pages.length;
  // 0 to count: the index past the last page is the end of the chapter.
  const [index, setIndex] = useState(() => clampPage(startPage, count));
  const page = Math.min(index, Math.max(count - 1, 0));
  const ended = count > 0 && index >= count;
  const [shown, setShown] = useState(true);
  const [bars, setBars] = useState({ top: 0, bottom: 0 });

  useEffect(() => {
    const timer = setTimeout(() => setShown(false), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, []);

  useWakeLock();
  useReadProgress(mangaId, progressKey(chapter), page, count);

  // Reaching the end of a chapter (the end card in page mode, the last page of a strip) asks
  // once whether a title dropped on MyAnimeList should go back to reading.
  const dropped = useDroppedPrompt(mangaId, "manga");
  const asked = useRef(false);
  const finished = settings.mode === "page" ? ended : count > 0 && page >= count - 1;
  useEffect(() => {
    if (!finished || asked.current) return;
    asked.current = true;
    dropped.check();
  }, [finished, dropped]);

  const goTo = useCallback((target: number) => setIndex(clampPage(target, count)), [count]);

  // The end card is one step past the last page; the controls come up with it.
  const goToIndex = useCallback(
    (target: number) => {
      const next = Math.min(Math.max(target, 0), count);
      setIndex(next);
      if (next >= count) setShown(true);
    },
    [count],
  );

  const step = useCallback((delta: -1 | 1) => goToIndex(index + delta), [goToIndex, index]);

  const leave = useCallback(() => router.push(mangaHref(mangaId)), [router, mangaId]);
  const toggle = useCallback(() => setShown((s) => !s), []);
  const hide = useCallback(() => setShown(false), []);
  const onHeights = useCallback((top: number, bottom: number) => setBars({ top, bottom }), []);
  const first = useCallback(() => goTo(0), [goTo]);
  const last = useCallback(() => goTo(count - 1), [goTo, count]);
  const onZone = useCallback((zone: Zone) => (zone === "toggle" ? toggle() : step(zone === "forward" ? 1 : -1)), [toggle, step]);

  useReaderKeys(settings.direction, settings.mode === "page", { step, first, last, leave, toggleControls: toggle });

  // The neighbours are on the track already; the two pages after them are fetched ahead too,
  // so a run of quick turns never waits.
  useEffect(() => {
    if (settings.mode !== "page") return;
    const ahead = pages.slice(page + 2, page + 4).map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
    return () => ahead.forEach((img) => (img.src = ""));
  }, [pages, page, settings.mode]);

  const chapterHref = (target: Chapter) => readHref(source, mangaId, target.id, lang);
  const end = (
    <EndCard title={title} next={next} nextHref={next ? chapterHref(next) : null} titleHref={mangaHref(mangaId)}>
      {dropped.asking && <DroppedPrompt namespace="reader" inline onAccept={dropped.accept} onDismiss={dropped.dismiss} />}
    </EndCard>
  );

  return (
    <div className="fixed inset-0 z-[60] select-none bg-reader text-fg" data-mode={settings.mode}>
      {settings.mode === "page" ? (
        <div
          // With the bars up, a page fits between them; sideways, it keeps clear of the notch.
          className="absolute inset-0 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] transition-[padding] duration-200"
          style={shown ? { paddingTop: bars.top, paddingBottom: bars.bottom } : undefined}
        >
          <PagedView pages={pages} index={index} direction={settings.direction} onIndex={goToIndex} onZone={onZone} chapterEnd={end} />
        </div>
      ) : (
        // The strip runs under the bars.
        <div className="absolute inset-0" onClick={toggle} role="presentation">
          <StripView pages={pages} page={page} startPage={startPage} onPageChange={setIndex} onScrollDown={hide} chapterEnd={end} />
        </div>
      )}
      {!shown && !ended && count > 0 && (
        // Where you are, while the bars are away.
        <p
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[calc(0.5rem+env(safe-area-inset-bottom))] right-[calc(0.75rem+env(safe-area-inset-right))] rounded-full bg-bg/80 px-2.5 py-1 text-xs tabular-nums text-muted"
        >
          {page + 1} / {count}
        </p>
      )}
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
