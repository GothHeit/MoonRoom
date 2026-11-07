import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { TvHero, type TvSlide } from "@/components/tv/TvHero";
import { TvHomeRows } from "@/components/tv/TvHomeRows";
import { TvPage } from "@/components/tv/TvPage";
import { TvHomeSkeleton } from "@/components/tv/TvSkeleton";
import { tvHref } from "@/components/tv/paths";
import { animeHref, posterOf } from "@/lib/catalog";
import { genreName } from "@/lib/genres";
import { serverApi, unwrap } from "@/lib/server-api";
import { cleanSynopsis } from "@/lib/synopsis";

async function HomeContent({ locale }: { locale: string }) {
  const t = await getTranslations("home");
  const tTitle = await getTranslations("titlePage");
  const tGenres = await getTranslations("genres");
  const home = await unwrap((await serverApi()).GET("/home", { params: { query: { lang: locale === "pt" ? "pt" : "en" } } }), locale, "tv");
  const slides: TvSlide[] = home.heroes.map(({ anime, synopsis, backdrop, wide_art }) => ({
    id: anime.id,
    title: anime.title,
    href: tvHref(animeHref(anime.id)),
    meta:
      [
        anime.mean ? t("score", { score: anime.mean.toFixed(1) }) : null,
        anime.media_type && tTitle.has(`mediaType.${anime.media_type}`) ? tTitle(`mediaType.${anime.media_type}`) : null,
        (anime.genres ?? [])
          .slice(0, 2)
          .map((g) => genreName(tGenres, g))
          .join(", "),
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    synopsis: cleanSynopsis(synopsis) || undefined,
    image: wide_art ?? backdrop ?? posterOf(anime),
    wide: !!wide_art,
  }));
  return (
    <>
      {slides.length > 0 && <TvHero slides={slides} />}
      {home.rows.length > 0 ? (
        <TvHomeRows rows={home.rows} />
      ) : (
        <p className="px-[var(--tv-x)] py-24 text-[1.75rem] text-muted">{t("empty")}</p>
      )}
    </>
  );
}

export default async function TvHome({ params }: PageProps<"/[locale]/tv">) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <TvPage initial="tv-hero-play">
      <Suspense fallback={<TvHomeSkeleton />}>
        <HomeContent locale={locale} />
      </Suspense>
    </TvPage>
  );
}
