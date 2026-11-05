import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { TvPosterCard } from "@/components/tv/TvCards";
import { TvGroup } from "@/components/tv/TvGroup";
import { TvPage } from "@/components/tv/TvPage";
import { TvPillLink } from "@/components/tv/TvPillLink";
import { TvSearchField } from "@/components/tv/TvSearchField";
import { TvGridSkeleton } from "@/components/tv/TvSkeleton";
import { tvHref } from "@/components/tv/paths";
import { animeHref, captionOf, posterOf, type AnimeCard } from "@/lib/catalog";
import { genreName } from "@/lib/genres";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Grid({ items, label }: { items: AnimeCard[]; label: string }) {
  return (
    <TvGroup focusKey="tv-search-results">
      <ul aria-label={label} className="grid grid-cols-6 gap-x-8 gap-y-10 px-[var(--tv-x)] py-6">
        {items.map((a) => (
          <li key={a.id}>
            <TvPosterCard focusKey={`tv-result-${a.id}`} href={tvHref(animeHref(a.id))} title={a.title} image={posterOf(a)} caption={captionOf(a)} className="w-full" />
          </li>
        ))}
      </ul>
    </TvGroup>
  );
}

async function Results({ q, genre, locale }: { q: string; genre?: number; locale: string }) {
  const t = await getTranslations("tv.search");
  const api = await serverApi();
  const items = q
    ? (await unwrap(api.GET("/anime/search", { params: { query: { q } } }), locale, "tv")).data
    : (await unwrap(api.GET("/anime/browse", { params: { query: { genre } } }), locale, "tv")).data;
  if (items.length === 0) {
    return (
      <div className="px-[var(--tv-x)] py-16">
        <p className="font-display text-[3rem]">{q ? t("empty", { q }) : t("emptyGenre")}</p>
        <p className="mt-3 max-w-[50rem] text-[1.75rem] text-muted">{t("emptyHint")}</p>
      </div>
    );
  }
  return <Grid items={items} label={q ? t("resultsFor", { q }) : t("title")} />;
}

/** No query yet: genres to browse by, one press each. */
async function Genres({ active }: { active?: number }) {
  const t = await getTranslations("tv.search");
  const tGenres = await getTranslations("genres");
  const genres = await (await serverApi())
    .GET("/anime/genres")
    .then((r) => r.data ?? [], () => []);
  if (genres.length === 0) return null;
  return (
    <TvGroup focusKey="tv-genres" className="pt-8">
      <h2 className="px-[var(--tv-x)] font-sans text-[1.5rem] font-bold uppercase tracking-[0.14em] text-muted">{t("byGenre")}</h2>
      <div data-tv-scroller className="no-scrollbar flex gap-4 overflow-x-auto px-[var(--tv-x)] py-5">
        {genres.filter((g) => g.kind === "genre").map((g) => (
          <div key={g.id} className="shrink-0">
            <TvPillLink href={`/tv/search?genre=${g.id}`} variant={g.id === active ? "primary" : "secondary"} focusKey={`tv-genre-${g.id}`}>
              {genreName(tGenres, g)}
            </TvPillLink>
          </div>
        ))}
      </div>
    </TvGroup>
  );
}

export async function generateMetadata({ params }: PageProps<"/[locale]/tv/search">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tv.search" });
  return titled(t("title"));
}

export default async function TvSearchPage({ params, searchParams }: PageProps<"/[locale]/tv/search">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const q = first(query.q)?.trim().slice(0, 100) ?? "";
  const rawGenre = Number(first(query.genre));
  const genre = Number.isInteger(rawGenre) && rawGenre > 0 ? rawGenre : undefined;

  return (
    <TvPage initial="tv-search-input">
      <TvGroup top className="px-[var(--tv-x)] pt-10">
        <TvSearchField initial={q} />
      </TvGroup>
      {!q && (
        <Suspense fallback={null}>
          <Genres active={genre} />
        </Suspense>
      )}
      {q || genre ? (
        <Suspense key={`${q}|${genre ?? ""}`} fallback={<TvGridSkeleton />}>
          <Results q={q} genre={genre} locale={locale} />
        </Suspense>
      ) : (
        <p className="px-[var(--tv-x)] pt-10 text-[1.75rem] text-muted">{(await getTranslations("tv.search"))("prompt")}</p>
      )}
    </TvPage>
  );
}
