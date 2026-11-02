import type { components } from "@app/api-client";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { HeroSplit } from "@/components/ui/HeroSplit";
import { genreName } from "@/lib/genres";
import { cleanSynopsis } from "@/lib/synopsis";

import { AddToList, type ListState } from "./AddToList";
import { Synopsis } from "./Synopsis";

type Details = components["schemas"]["AnimeDetailsOut"];

type Props = {
  anime: Details;
  /** Streamed in once the sources are known: the "watch here" badge, the play button and the hint. */
  badge: ReactNode;
  play: ReactNode;
  hint: ReactNode;
  list: ListState;
  /** Painted over the poster once the wide picture of the show is known (streamed in). */
  art?: ReactNode;
};

export async function TitleHeader({ anime, badge, play, hint, list, art }: Props) {
  const t = await getTranslations("titlePage");
  const locale = await getLocale();
  const tGenres = await getTranslations("genres");
  const label = (group: string, key: string | null | undefined, values?: Record<string, string | number>) =>
    key && t.has(`${group}.${key}`) ? t(`${group}.${key}`, values) : key;

  const facts = [
    anime.mean != null && t("score", { score: anime.mean.toFixed(2) }),
    anime.start_season &&
      label("season", anime.start_season.season, { year: anime.start_season.year }),
    label("mediaType", anime.media_type),
    anime.num_episodes ? t("episodes", { count: anime.num_episodes }) : null,
    label("airing", anime.status),
  ].filter(Boolean) as string[];
  const english = anime.alternative_titles?.en;
  const poster = anime.main_picture?.large ?? anime.main_picture?.medium;

  const info = (
    <>
      {badge}
      <h1
        className="mt-3 break-words text-4xl leading-[0.95] tracking-[-0.02em] md:text-5xl xl:text-6xl"
      >
        {anime.title}
      </h1>
      {english && english !== anime.title && <p className="mt-2 text-muted">{english}</p>}
      {facts.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-soft">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </>
  );
  const more = (
    <>
      <div className="mt-6 flex flex-wrap gap-3">
        {play}
        <AddToList titleId={anime.id} state={list} />
      </div>
      {hint}

      <h2 className="sr-only">{t("synopsis")}</h2>
      <Synopsis text={cleanSynopsis(anime.synopsis) || t("noSynopsis")} />
      {locale === "pt" && anime.synopsis_lang === "en" && <p className="mt-1 text-xs text-muted">{t("synopsisEnglish")}</p>}
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {!!anime.studios?.length && (
          <>
            <dt className="text-muted">{t("studios")}</dt>
            <dd>{anime.studios?.map((s) => s.name).join(", ")}</dd>
          </>
        )}
        {!!anime.genres?.length && (
          <>
            <dt className="text-muted">{t("genres")}</dt>
            <dd className="flex flex-wrap gap-2">
              {anime.genres?.map((g) => (
                <span key={g.id} className="rounded-full border border-line-strong px-3 py-1 text-xs">
                  {genreName(tGenres, g)}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </>
  );

  return (
    <section className="pt-16 sm:pt-20">
      <HeroSplit overlay={art} poster={poster} posterAlt={t("posterAlt", { title: anime.title })}>
        {info}
        {more}
      </HeroSplit>
    </section>
  );
}
