"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

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
  const pages = Math.ceil(episodes.length / PAGE_SIZE);
  const shown = episodes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const byEpisode = new Map(progress.map((p) => [p.episode, p]));

  return (
    <section aria-labelledby="episodes-heading" className="px-4 sm:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="episodes-heading" className="text-2xl">
          {t("episodeList")}
        </h2>
        {pages > 1 && (
          <label className="text-sm text-muted">
            <span className="sr-only">{t("range")}</span>
            <select
              value={page}
              onChange={(e) => setPage(Number(e.target.value))}
              className="h-11 rounded-full border border-line-strong bg-bg px-4 text-fg"
            >
              {Array.from({ length: pages }, (_, i) => {
                const slice = episodes.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
                return (
                  <option key={i} value={i}>
                    {slice[0]}–{slice[slice.length - 1]}
                  </option>
                );
              })}
            </select>
          </label>
        )}
      </div>
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
