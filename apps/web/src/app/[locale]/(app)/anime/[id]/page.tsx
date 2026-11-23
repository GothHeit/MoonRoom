import { errorCode } from "@app/api-client";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import type { ListState } from "@/components/title/AddToList";
import { TitleComments, TitleCommentsLink } from "@/components/comments/TitleComments";
import { EpisodeList } from "@/components/title/EpisodeList";
import { titleArt } from "@/components/title/titleArt";
import { TitleHeader } from "@/components/title/TitleHeader";
import {
  WatchBadge,
  WatchBadgeSkeleton,
  WatchHint,
  WatchPlay,
  WatchPlaySkeleton,
  WideArt,
} from "@/components/title/WatchParts";
import { watchPlan } from "@/components/title/watchPlan";
import { PosterCard } from "@/components/ui/PosterCard";
import { Row } from "@/components/ui/Row";
import { Skeleton } from "@/components/ui/Skeleton";
import { APP_NAME } from "@/lib/brand";
import { serverApi, unwrap } from "@/lib/server-api";

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) notFound();
  return id;
}

// The metadata and the page share one details call per request.
const details = cache(async (id: number, locale: string) =>
  (await serverApi()).GET("/anime/{anime_id}", {
    params: { path: { anime_id: id }, query: { lang: locale === "pt" ? "pt" : "en" } },
  }),
);

export async function generateMetadata({ params }: PageProps<"/[locale]/anime/[id]">): Promise<Metadata> {
  const { locale, id } = await params;
  const { data } = await details(parseId(id), locale);
  return { title: data ? `${data.title} · ${APP_NAME}` : APP_NAME };
}

/** The user's list status. A failed lookup is "unavailable", never an empty list entry. */
async function listState(id: number): Promise<ListState> {
  try {
    const api = await serverApi();
    const { data, error } = await api.GET("/me/animelist/{anime_id}", { params: { path: { anime_id: id } } });
    if (data) return data.status ?? null;
    // Not linked: the picker starts empty and says so when the user tries to save.
    return errorCode(error) === "mal_not_linked" ? null : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Holds the episodes' place (heading and first cards, same grid as EpisodeList) while the sources load. */
function EpisodesSkeleton() {
  return (
    <section aria-hidden="true" className="px-4 sm:px-8">
      <div className="mb-4 flex min-h-11 items-center">
        <Skeleton className="h-8 w-40" />
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 sm:gap-y-6 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 min-[1800px]:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="flex items-center gap-3 sm:block">
            <Skeleton className="aspect-video w-36 shrink-0 sm:w-full" />
            <div className="min-w-0 flex-1 sm:mt-2.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-2 h-4 w-3/4" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function Episodes({ id, locale }: { id: number; locale: string }) {
  const [plan, art] = await Promise.all([watchPlan(id), titleArt(id, locale)]);
  if (!plan) return null;
  return (
    <EpisodeList
      source={plan.source}
      lang={plan.lang}
      animeId={id}
      episodes={plan.episodes}
      progress={plan.progress}
      current={plan.next.episode}
      thumbnails={plan.thumbnails}
      art={art.episodes}
    />
  );
}

export default async function TitlePage({ params }: PageProps<"/[locale]/anime/[id]">) {
  const { locale, id: rawId } = await params;
  setRequestLocale(locale);
  const id = parseId(rawId);
  const t = await getTranslations("titlePage");

  const [anime, list] = await Promise.all([unwrap(details(id, locale), locale), listState(id)]);

  // The sources come from scrapers that can be slow or down: the page renders without them and
  // the parts that need them stream in.
  return (
    <>
      <TitleHeader
        anime={anime}
        list={list}
        art={
          <Suspense fallback={null}>
            <WideArt id={id} locale={locale} />
          </Suspense>
        }
        badge={
          <Suspense fallback={<WatchBadgeSkeleton />}>
            <WatchBadge id={id} />
          </Suspense>
        }
        play={
          <Suspense fallback={<WatchPlaySkeleton />}>
            <WatchPlay id={id} />
          </Suspense>
        }
        hint={
          <Suspense fallback={null}>
            <WatchHint id={id} />
          </Suspense>
        }
        comments={
          <Suspense fallback={null}>
            <TitleCommentsLink kind="anime" id={id} />
          </Suspense>
        }
      />
      <div className="flex flex-col gap-10 py-6">
        <Suspense fallback={<EpisodesSkeleton />}>
          <Episodes id={id} locale={locale} />
        </Suspense>
        {!!anime.related_anime?.length && (
          <Row title={t("related")}>
            {anime.related_anime?.map((r) => (
              <PosterCard
                key={r.anime.id}
                href={`/anime/${r.anime.id}`}
                title={r.anime.title}
                image={r.anime.main_picture?.medium}
                caption={
                  t.has(`relation.${r.relation_type}`) ? t(`relation.${r.relation_type}`) : r.relation_type_formatted
                }
                seed={r.anime.id}
              />
            ))}
          </Row>
        )}
        {!!anime.recommendations?.length && (
          <Row title={t("recommended")}>
            {anime.recommendations?.map((r) => (
              <PosterCard
                key={r.anime.id}
                href={`/anime/${r.anime.id}`}
                title={r.anime.title}
                image={r.anime.main_picture?.medium}
                seed={r.anime.id}
              />
            ))}
          </Row>
        )}
        <Suspense fallback={null}>
          <TitleComments kind="anime" id={id} last={anime.num_episodes} />
        </Suspense>
      </div>
    </>
  );
}
