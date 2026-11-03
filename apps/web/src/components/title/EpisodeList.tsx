"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { artImage } from "@/components/ui/artImage";
import { placeholderFor } from "@/components/ui/PosterCard";
import { Link } from "@/i18n/navigation";
import { watchHref, type Lang } from "@/lib/watch-target";

import { progressRatio, type Progress } from "./resume";

// Widths the still is shown at: a 144 px thumbnail on phones, one grid column from sm up.
const STILL_SIZES =
  "(min-width: 1800px) 17vw, (min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 768px) 33vw, (min-width: 640px) 50vw, 144px";

// Long shows are split into pages so the list stays quick to scan.
export const PAGE_SIZE = 100;

export function pageOf(episodes: number[], episode: number) {
  return Math.max(0, Math.floor(Math.max(episodes.indexOf(episode), 0) / PAGE_SIZE));
}

type Props = {
  source: string;
  lang?: Lang;
  animeId: number;
  episodes: number[];
  progress: Progress[];
  /** Page shown first: the one holding the episode the primary button opens. */
  current?: number;
  /** Episode number -> still image from the source (proxied, relative to the API). */
  thumbnails?: Record<string, string>;
  /** Episode number -> title and still from outside the source (ani.zip). */
  art?: Record<string, EpisodeArt>;
};

type EpisodeArt = { title?: string | null; image?: string | null };

export function EpisodeList({ source, lang = "sub", animeId, episodes, progress, current, thumbnails, art }: Props) {
  const t = useTranslations("titlePage");
  const [page, setPage] = useState(current === undefined ? 0 : pageOf(episodes, current));
  const chips = useRef<HTMLDivElement>(null);
  // Keep the chosen range visible in the scrolling row (sideways only, never the page).
  useEffect(() => {
    const row = chips.current;
    const chip = row?.children[page] as HTMLElement | undefined;
    if (row && chip) row.scrollLeft = chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2;
  }, [page]);
  const pages = Math.ceil(episodes.length / PAGE_SIZE);
  const shown = episodes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const byEpisode = new Map(progress.map((p) => [p.episode, p]));

  return (
    <section aria-labelledby="episodes-heading" className="px-4 sm:px-8">
      <h2 id="episodes-heading" className="mb-3 flex items-baseline gap-3 text-2xl">
        {t("episodeList")}
        <span className="font-sans text-sm text-muted">{episodes.length}</span>
      </h2>
      {pages > 1 && (
        <div ref={chips} role="group" aria-label={t("range")} className="no-scrollbar relative -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-8 sm:px-8">
          {Array.from({ length: pages }, (_, i) => {
            const slice = episodes.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
            const active = i === page;
            return (
              <button
                key={i}
                type="button"
                aria-pressed={active}
                onClick={() => setPage(i)}
                className={`press h-11 shrink-0 rounded-full border px-4 text-sm font-bold tabular-nums ${
                  active ? "border-accent bg-accent text-on-accent" : "border-line-strong text-soft hover:border-accent hover:text-fg"
                }`}
              >
                {slice[0]}–{slice[slice.length - 1]}
              </button>
            );
          })}
        </div>
      )}
      {/* Phones: a list with the still beside the text. Wider: a grid that fills the width. */}
      <ul className="grid gap-4 sm:grid-cols-2 sm:gap-y-6 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 min-[1800px]:grid-cols-6">
        {shown.map((ep) => {
          const p = byEpisode.get(ep);
          const ratio = progressRatio(p);
          const pct = ratio === undefined ? undefined : Math.round(ratio * 100);
          const still = thumbnails?.[ep];
          const extra = art?.[ep];
          const image = still ? `/api/proxy${still}` : extra?.image;
          const left =
            p && !p.completed && p.duration_seconds
              ? Math.max(1, Math.round((p.duration_seconds - p.position_seconds) / 60))
              : undefined;
          const status = p?.completed
            ? { text: t("watched"), tone: "text-success" }
            : left !== undefined
              ? { text: t("minutesLeft", { minutes: left }), tone: "text-accent" }
              : ep === current
                ? { text: t("upNext"), tone: "text-accent" }
                : undefined;
          return (
            <li key={ep}>
              <Link href={watchHref(source, animeId, ep, lang)} className="group flex items-center gap-3 sm:block">
                <div
                  className={`relative aspect-video w-36 shrink-0 overflow-hidden rounded-ui transition-transform duration-200 ease-out group-hover:scale-[1.03] group-focus-visible:scale-[1.03] group-active:scale-[0.98] sm:w-full ${placeholderFor(animeId + ep)} ${ep === current ? "outline-2 outline-offset-2 outline-accent" : ""}`}
                >
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- stills come from the source or ani.zip
                    <img
                      {...(still ? { src: image } : artImage(image ?? "", STILL_SIZES))}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-2 left-3 font-display text-4xl leading-none text-accent sm:bottom-3 sm:left-4 sm:text-5xl"
                    >
                      {String(ep).padStart(2, "0")}
                    </span>
                  )}
                  {pct !== undefined && (
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-label={t("episode", { episode: ep })}
                      className="absolute inset-x-0 bottom-0 h-1 bg-black/50"
                    >
                      <div className={`h-full ${p?.completed ? "bg-success" : "bg-accent"}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 sm:mt-2.5">
                  <p className="text-xs font-bold uppercase tracking-wide text-muted">
                    {t("episode", { episode: ep })}
                    {status && <span className={`ml-2 ${status.tone}`}>{status.text}</span>}
                  </p>
                  {extra?.title && <p className="mt-1 line-clamp-2 text-sm font-bold">{extra.title}</p>}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
