import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { cache, Suspense } from "react";

import { titleArt } from "@/components/title/titleArt";
import { watchPlan } from "@/components/title/watchPlan";
import { TvPosterCard } from "@/components/tv/TvCards";
import { TvEpisodes } from "@/components/tv/TvEpisodes";
import { TvPage } from "@/components/tv/TvPage";
import { TvPillLink } from "@/components/tv/TvPillLink";
import { TvRow } from "@/components/tv/TvRow";
import { TvRowSkeleton } from "@/components/tv/TvSkeleton";
import { tvHref } from "@/components/tv/paths";
import { artImage } from "@/components/ui/artImage";
import { Skeleton } from "@/components/ui/Skeleton";
import { APP_NAME } from "@/lib/brand";
import { animeHref } from "@/lib/catalog";
import { genreName } from "@/lib/genres";
import { serverApi, unwrap } from "@/lib/server-api";
import { cleanSynopsis } from "@/lib/synopsis";

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) notFound();
  return id;
}

const details = cache(async (id: number, locale: string) =>
  (await serverApi()).GET("/anime/{anime_id}", {
    params: { path: { anime_id: id }, query: { lang: locale === "pt" ? "pt" : "en" } },
  }),
);

export async function generateMetadata({ params }: PageProps<"/[locale]/tv/anime/[id]">): Promise<Metadata> {
  const { locale, id } = await params;
  const { data } = await details(parseId(id), locale);
  return { title: data ? `${data.title} · ${APP_NAME}` : APP_NAME };
}

/** The one pill: play, continue or rewatch, once the sources answered. */
async function Play({ id }: { id: number }) {
  const [plan, t, tv] = await Promise.all([watchPlan(id), getTranslations("titlePage"), getTranslations("tv.title")]);
  if (!plan) return <p className="text-[1.75rem] text-muted">{tv("unavailable")}</p>;
  return (
    <TvPillLink href={plan.href} focusKey="tv-title-play">
      <span aria-hidden="true">▶</span>
      {plan.next.resume ? t("continue", { episode: plan.next.episode }) : plan.next.rewatch ? t("rewatch") : t("play", { episode: plan.next.episode })}
    </TvPillLink>
  );
}

async function WideArt({ id, poster }: { id: number; poster?: string | null }) {
  const locale = await getLocale();
  const art = await titleArt(id, locale);
  if (art.backdrop) {
    // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
    return <img {...artImage(art.backdrop, "60vw")} alt="" fetchPriority="high" decoding="async" className="art-fade-in absolute inset-0 h-full w-full object-cover" />;
  }
  if (!poster) return null;
  // eslint-disable-next-line @next/next/no-img-element -- remote catalog poster
  return <img src={poster} alt="" decoding="async" className="absolute inset-y-10 left-1/2 h-[calc(100%-5rem)] w-auto -translate-x-1/2 rounded-ui object-contain" />;
}

async function Episodes({ id, locale }: { id: number; locale: string }) {
  const [plan, art] = await Promise.all([watchPlan(id), titleArt(id, locale)]);
  if (!plan) return null;
  return (
    <TvEpisodes
      source={plan.source}
      lang={plan.lang}
      animeId={id}
      episodes={plan.episodes}
      progress={plan.progress}
      current={plan.next.episode}
      thumbnails={plan.thumbnails}
      art={art.episodes ?? {}}
    />
  );
}

export default async function TvTitlePage({ params }: PageProps<"/[locale]/tv/anime/[id]">) {
  const { locale, id: rawId } = await params;
  setRequestLocale(locale);
  const id = parseId(rawId);
  const t = await getTranslations("titlePage");
  const tGenres = await getTranslations("genres");
  const anime = await unwrap(details(id, locale), locale, "tv");
  const label = (group: string, key: string | null | undefined, values?: Record<string, string | number>) =>
    key && t.has(`${group}.${key}`) ? t(`${group}.${key}`, values) : key;
  const facts = [
    anime.mean != null && t("score", { score: anime.mean.toFixed(2) }),
    anime.start_season && label("season", anime.start_season.season, { year: anime.start_season.year }),
    label("mediaType", anime.media_type),
    anime.num_episodes ? t("episodes", { count: anime.num_episodes }) : null,
    (anime.genres ?? [])
      .slice(0, 3)
      .map((g) => genreName(tGenres, g))
      .join(", "),
  ].filter(Boolean) as string[];
  const english = anime.alternative_titles?.en;
  const poster = anime.main_picture?.large ?? anime.main_picture?.medium;
  const long = anime.title.length > 28;

  return (
    <TvPage initial="tv-title-play">
      {/* One pill at most, so no group: an empty group would catch focus when a title only tracks. */}
      <div data-tv-section="top" className="grid min-h-[37rem] grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex min-w-0 flex-col justify-center py-10 pl-[var(--tv-x)] pr-14">
          <h1 className={`line-clamp-3 break-words leading-[0.95] tracking-[-0.02em] ${long ? "text-[4.25rem]" : "text-[5.5rem]"}`}>{anime.title}</h1>
          {english && english !== anime.title && <p className="mt-3 line-clamp-1 text-[1.75rem] text-muted">{english}</p>}
          {facts.length > 0 && <p className="mt-5 text-[1.5rem] font-medium text-soft">{facts.join(" · ")}</p>}
          <p className="mt-5 line-clamp-4 text-[1.75rem] leading-snug text-soft">{cleanSynopsis(anime.synopsis) || t("noSynopsis")}</p>
          <div className="mt-9 flex items-center gap-6">
            <Suspense fallback={<Skeleton className="h-[4.5rem] w-[22rem] rounded-full" />}>
              <Play id={id} />
            </Suspense>
          </div>
        </div>
        <div className="relative overflow-hidden rounded-bl-ui bg-surface">
          <Suspense fallback={null}>
            <WideArt id={id} poster={poster} />
          </Suspense>
        </div>
      </div>
      <div className="space-y-8 pt-12">
        <Suspense fallback={<TvRowSkeleton wide />}>
          <Episodes id={id} locale={locale} />
        </Suspense>
        {!!anime.related_anime?.length && (
          <TvRow title={t("related")} focusKey="tv-related">
            {anime.related_anime.map((r) => (
              <TvPosterCard
                key={r.anime.id}
                focusKey={`tv-related-${r.anime.id}`}
                href={tvHref(animeHref(r.anime.id))}
                title={r.anime.title}
                image={r.anime.main_picture?.medium}
                caption={t.has(`relation.${r.relation_type}`) ? t(`relation.${r.relation_type}`) : r.relation_type_formatted}
                seed={r.anime.id}
              />
            ))}
          </TvRow>
        )}
        {!!anime.recommendations?.length && (
          <TvRow title={t("recommended")} focusKey="tv-recommended">
            {anime.recommendations.slice(0, 20).map((r) => (
              <TvPosterCard
                key={r.anime.id}
                focusKey={`tv-recommended-${r.anime.id}`}
                href={tvHref(animeHref(r.anime.id))}
                title={r.anime.title}
                image={r.anime.main_picture?.medium}
                seed={r.anime.id}
              />
            ))}
          </TvRow>
        )}
      </div>
    </TvPage>
  );
}
