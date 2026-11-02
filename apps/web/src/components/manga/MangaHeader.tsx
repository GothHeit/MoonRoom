import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { HeroSplit } from "@/components/ui/HeroSplit";
import { Synopsis } from "@/components/title/Synopsis";
import { genreName } from "@/lib/genres";
import type { MangaDetails } from "@/lib/manga";
import { cleanSynopsis } from "@/lib/synopsis";

type Props = {
  manga: MangaDetails;
  /** Streamed in once the sources are known: the "read here" badge and the primary pill. */
  badge: ReactNode;
  action: ReactNode;
};

/** The title page header: cover, serif title, facts, synopsis. The same layout as the anime one. */
export async function MangaHeader({ manga, badge, action }: Props) {
  const t = await getTranslations("manga.page");
  const tGenres = await getTranslations("genres");
  const label = (group: string, key: string | null | undefined) => (key && t.has(`${group}.${key}`) ? t(`${group}.${key}`) : key);

  const year = manga.start_date?.slice(0, 4);
  const kicker = [label("mediaType", manga.media_type), year, label("status", manga.status)].filter(Boolean).join(" · ");
  const facts = [
    manga.mean != null && t("score", { score: manga.mean.toFixed(2) }),
    manga.num_chapters ? t("chapters", { count: manga.num_chapters }) : null,
    manga.num_volumes ? t("volumes", { count: manga.num_volumes }) : null,
  ].filter(Boolean) as string[];
  const english = manga.alternative_titles?.en;
  const cover = manga.main_picture?.large ?? manga.main_picture?.medium;
  const authors = (manga.authors ?? []).map((a) => [a.first_name, a.last_name].filter(Boolean).join(" ")).filter(Boolean);

  return (
    <section className="pt-16 sm:pt-20">
      <HeroSplit poster={cover} posterAlt={t("coverAlt", { title: manga.title })}>
        {badge}
        {kicker && <p className="kicker mt-3">{kicker}</p>}
        <h1 className="mt-2 break-words text-4xl leading-[0.95] tracking-[-0.02em] md:text-5xl xl:text-6xl">{manga.title}</h1>
        {english && english !== manga.title && <p className="mt-2 text-muted">{english}</p>}
        {facts.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-soft">
            {facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex flex-wrap gap-3">{action}</div>
        <h2 className="sr-only">{t("synopsis")}</h2>
        <div className="mt-6">
          <Synopsis text={cleanSynopsis(manga.synopsis) || t("noSynopsis")} />
        </div>
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {authors.length > 0 && (
            <>
              <dt className="text-muted">{t("authors")}</dt>
              <dd>{authors.join(", ")}</dd>
            </>
          )}
          {!!manga.genres?.length && (
            <>
              <dt className="text-muted">{t("genres")}</dt>
              <dd className="flex flex-wrap gap-2">
                {manga.genres?.map((g) => (
                  <span key={g.id} className="rounded-full border border-line-strong px-3 py-1 text-xs">
                    {genreName(tGenres, g)}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </HeroSplit>
    </section>
  );
}
