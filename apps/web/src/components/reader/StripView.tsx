"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { placeholderFor } from "@/components/ui/PosterCard";

type Props = {
  pages: string[];
  page: number;
  startPage: number;
  onPageChange: (index: number) => void;
  chapterEnd: ReactNode;
};

// Pages this close to the one on screen are fetched ahead.
const AHEAD = 3;

/**
 * The whole chapter as one column. Each page keeps a reserved height until it loads, so the
 * strip never jumps; the page most on screen is the current one.
 */
export function StripView({ pages, page, startPage, onPageChange, chapterEnd }: Props) {
  const t = useTranslations("reader");
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());
  const [reach, setReach] = useState(Math.min(startPage + AHEAD, pages.length));

  // Open on the saved page, and count the pages that loaded before React took over.
  useEffect(() => {
    items.current[startPage]?.scrollIntoView({ block: "start" });
    const already = items.current.flatMap((el, i) => {
      const img = el?.querySelector("img");
      return img?.complete && img.naturalWidth > 0 ? [i] : [];
    });
    if (already.length) setLoaded((s) => new Set([...s, ...already]));
  }, [startPage]);

  // A jump from the slider: scroll there, unless it is already the page on screen.
  const current = useRef(page);
  useEffect(() => {
    if (current.current !== page) {
      current.current = page;
      items.current[page]?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [page]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { index: number; ratio: number } | null = null;
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (entry.isIntersecting && (!best || entry.intersectionRatio > best.ratio)) best = { index, ratio: entry.intersectionRatio };
        }
        if (best) {
          current.current = best.index;
          onPageChange(best.index);
          setReach((r) => Math.max(r, Math.min(best.index + 1 + AHEAD, pages.length)));
        }
      },
      { root: root.current, threshold: [0.25, 0.5, 0.75] },
    );
    items.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [pages.length, onPageChange]);

  return (
    <div ref={root} className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-[56rem]">
        {pages.map((src, i) => (
          <div
            key={src}
            ref={(el) => {
              items.current[i] = el;
            }}
            data-index={i}
            className={`relative ${loaded.has(i) ? "" : `aspect-[2/3] ${placeholderFor(i)}`}`}
          >
            {i < reach && (
              // eslint-disable-next-line @next/next/no-img-element -- chapter pages come through the proxy
              <img
                src={src}
                alt={t("pageAlt", { page: i + 1 })}
                draggable={false}
                decoding="async"
                loading={i <= startPage + 1 ? "eager" : "lazy"}
                onLoad={() => setLoaded((s) => new Set(s).add(i))}
                className="block w-full"
              />
            )}
          </div>
        ))}
        <div className="flex min-h-[60dvh] items-center justify-center px-4 py-16">{chapterEnd}</div>
      </div>
    </div>
  );
}
