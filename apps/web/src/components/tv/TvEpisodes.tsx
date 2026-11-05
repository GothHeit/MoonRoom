"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { pageOf, PAGE_SIZE } from "@/components/title/EpisodeList";
import { progressRatio, type Progress } from "@/components/title/resume";
import { artImage } from "@/components/ui/artImage";
import { placeholderFor } from "@/components/ui/PosterCard";
import { watchHref, type Lang } from "@/lib/watch-target";

import { TvButton } from "./TvButton";
import { TvGroup } from "./TvGroup";
import { tvHref } from "./paths";
import { TvLink } from "./TvLink";

const STILL_SIZES = "26rem";

type EpisodeArt = { title?: string | null; image?: string | null };

type Props = {
  source: string;
  lang: Lang;
  animeId: number;
  episodes: number[];
  progress: Progress[];
  current: number;
  thumbnails: Record<string, string>;
  art: Record<string, EpisodeArt>;
};

/** Episodes in ranges of 100 (chips on top), as a grid of 16:9 stills. */
export function TvEpisodes({ source, lang, animeId, episodes, progress, current, thumbnails, art }: Props) {
  const t = useTranslations("titlePage");
  const [page, setPage] = useState(() => pageOf(episodes, current));
  const pages = Math.ceil(episodes.length / PAGE_SIZE);
  const shown = episodes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const byEpisode = new Map(progress.map((p) => [p.episode, p]));

  return (
    <section aria-labelledby="tv-episodes" data-tv-section className="px-[var(--tv-x)]">
      <h2 id="tv-episodes" className="flex items-baseline gap-4 text-[2.75rem]">
        {t("episodeList")}
        <span className="font-sans text-[1.5rem] text-muted">{episodes.length}</span>
      </h2>
      {pages > 1 && (
        <TvGroup focusKey="tv-episode-ranges" className="mt-6">
          <div role="group" aria-label={t("range")} data-tv-scroller className="no-scrollbar -mx-[var(--tv-x)] flex gap-4 overflow-x-auto px-[var(--tv-x)] py-3">
            {Array.from({ length: pages }, (_, i) => {
              const slice = episodes.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
              return (
                <TvButton key={i} focusKey={`tv-range-${i}`} selected={i === page} onPress={() => setPage(i)} className="shrink-0 tabular-nums">
                  {slice[0]}–{slice[slice.length - 1]}
                </TvButton>
              );
            })}
          </div>
        </TvGroup>
      )}
      {/* Down from Play lands on the episode Play opens. */}
      <TvGroup key={page} focusKey="tv-episodes" preferred={shown.includes(current) ? `tv-episode-${current}` : undefined}>
        <ul className="mt-6 grid grid-cols-4 gap-x-8 gap-y-10 py-4">
          {shown.map((ep) => {
            const p = byEpisode.get(ep);
            const ratio = progressRatio(p);
            const still = thumbnails[ep];
            const extra = art[ep];
            const image = still ? `/api/proxy${still}` : extra?.image;
            const status = p?.completed
              ? { text: t("watched"), tone: "text-success" }
              : ratio !== undefined
                ? p?.duration_seconds
                  ? { text: t("minutesLeft", { minutes: Math.max(1, Math.round((p.duration_seconds - p.position_seconds) / 60)) }), tone: "text-accent" }
                  : undefined
                : ep === current
                  ? { text: t("upNext"), tone: "text-accent" }
                  : undefined;
            return (
              <li key={ep}>
                <TvLink href={tvHref(watchHref(source, animeId, ep, lang))} focusKey={`tv-episode-${ep}`} label={[t("episode", { episode: ep }), extra?.title, status?.text].filter(Boolean).join(", ")}>
                  <div
                    className={`relative aspect-video overflow-hidden rounded-ui outline-[3px] outline-offset-4 outline-solid outline-transparent transition-transform duration-[160ms] ease-out group-data-[focused=true]:scale-[1.06] group-data-[focused=true]:outline-accent ${placeholderFor(animeId + ep)}`}
                  >
                    {image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- stills come from the source or ani.zip
                      <img {...(still ? { src: image } : artImage(image ?? "", STILL_SIZES))} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <span aria-hidden="true" className="absolute bottom-4 left-5 font-display text-[4.5rem] leading-none text-accent">
                        {String(ep).padStart(2, "0")}
                      </span>
                    )}
                    {ratio !== undefined && (
                      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1.5 bg-line">
                        <div className={`h-full ${p?.completed ? "bg-success" : "bg-accent"}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  <p className="mt-4 text-[1.375rem] font-bold uppercase tracking-wide text-muted">
                    {t("episode", { episode: ep })}
                    {status && <span className={`ml-3 ${status.tone}`}>{status.text}</span>}
                  </p>
                  {extra?.title && <p className="mt-1 line-clamp-2 text-[1.75rem] font-bold leading-tight text-soft group-data-[focused=true]:text-fg">{extra.title}</p>}
                </TvLink>
              </li>
            );
          })}
        </ul>
      </TvGroup>
    </section>
  );
}
