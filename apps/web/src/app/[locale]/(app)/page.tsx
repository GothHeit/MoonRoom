import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { FriendsActivity } from "@/components/rows/FriendsActivity";
import { HomeRows } from "@/components/rows/HomeRows";
import { HomeSkeleton } from "@/components/rows/HomeSkeleton";
import { HeroCarousel } from "@/components/ui/HeroCarousel";
import { animeHref, posterOf } from "@/lib/catalog";
import { genreName } from "@/lib/genres";
import { serverApi, unwrap } from "@/lib/server-api";
import { cleanSynopsis } from "@/lib/synopsis";

async function HomeContent({ locale }: { locale: string }) {
  const t = await getTranslations("home");
  const tTitle = await getTranslations("titlePage");
  const tGenres = await getTranslations("genres");
  const api = await serverApi();
  const [home, activity] = await Promise.all([
    unwrap(api.GET("/home", { params: { query: { lang: locale === "pt" ? "pt" : "en" } } }), locale),
    // The feed is a bonus: the home page works without it.
    api.GET("/friends/activity", { params: { query: { limit: 20 } } }).then((r) => r.data ?? [], () => []),
  ]);
  const slides = home.heroes.map(({ anime, synopsis, synopsis_lang, backdrop, wide_art }) => ({
    id: anime.id,
    title: anime.title,
    href: animeHref(anime.id),
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
    synopsisNote: locale === "pt" && synopsis_lang === "en" ? t("synopsisEnglish") : undefined,
    image: backdrop ?? posterOf(anime),
    wideArt: wide_art,
  }));

  return (
    <>
      {slides.length > 0 && <HeroCarousel slides={slides} cta={t("play")} />}
      {home.rows.length > 0 ? (
        <HomeRows rows={home.rows} />
      ) : (
        <p className="px-4 pb-24 pt-28 text-muted sm:px-8">{t("empty")}</p>
      )}
      <FriendsActivity items={activity} />
    </>
  );
}

export default async function Home({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <HomeContent locale={locale} />
    </Suspense>
  );
}
