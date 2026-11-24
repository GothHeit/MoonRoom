import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { SearchForm } from "@/components/shell/SearchForm";
import { GridSkeleton, PosterGrid } from "@/components/grid/PosterGrid";
import { ButtonLink } from "@/components/ui/Button";
import { PosterCard } from "@/components/ui/PosterCard";
import { Link } from "@/i18n/navigation";
import { animeHref, captionOf, posterOf } from "@/lib/catalog";
import { genreName } from "@/lib/genres";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

async function Results({ q, locale }: { q: string; locale: string }) {
  const t = await getTranslations("search");
  const { data } = await unwrap((await serverApi()).GET("/anime/search", { params: { query: { q } } }), locale);
  if (data.length === 0) return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <p className="font-display text-3xl">{t("empty", { q })}</p>
        <p className="max-w-md text-muted">{t("emptyHint")}</p>
        <ButtonLink href="/browse" variant="secondary">
          {t("browse")}
        </ButtonLink>
      </div>
    );
  return (
    <PosterGrid>
      {data.map((a) => (
        <PosterCard key={a.id} href={animeHref(a.id)} title={a.title} image={posterOf(a)} caption={captionOf(a)} />
      ))}
    </PosterGrid>
  );
}

/** How many genres the empty page offers. */
const GENRE_CHIPS = 12;

/** Nothing typed yet: somewhere to go instead of a bare line. */
async function Start() {
  const t = await getTranslations("search");
  const tGenres = await getTranslations("genres");
  // The chips are a shortcut; without them the page still has its prompt and the Browse button.
  const all = await (await serverApi()).GET("/anime/genres").then((r) => r.data ?? [], () => []);
  const genres = all.filter((g) => g.kind === "genre").slice(0, GENRE_CHIPS);
  return (
    <div className="flex flex-col items-start gap-6">
      <p className="text-soft">{t("prompt")}</p>
      {genres.length > 0 && (
        <section aria-labelledby="search-genres" className="flex flex-col gap-3">
          <h2 id="search-genres" className="font-sans text-sm font-bold tracking-normal text-muted">
            {t("byGenre")}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {genres.map((g) => (
              <li key={g.id}>
                <Link
                  href={{ pathname: "/browse", query: { genre: g.id } }}
                  className="press inline-flex min-h-11 items-center rounded-full border border-line-strong px-4 text-sm font-medium text-soft hover:border-accent hover:text-fg"
                >
                  {genreName(tGenres, g)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ButtonLink href="/browse" variant="secondary">
        {t("browse")}
      </ButtonLink>
    </div>
  );
}

export async function generateMetadata({ params, searchParams }: PageProps<"/[locale]/search">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "search" });
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 100) ?? "";
  return titled(q ? t("resultsFor", { q }) : t("title"));
}

export default async function SearchPage({ params, searchParams }: PageProps<"/[locale]/search">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("search");
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 100) ?? "";

  return (
    <section className="px-4 pb-8 pt-24 sm:px-8">
      <h1 className="mb-6 text-4xl sm:text-5xl">{q ? t("resultsFor", { q }) : t("title")}</h1>
      <SearchForm key={q} initial={q} />
      {q ? (
        <Suspense key={q} fallback={<GridSkeleton />}>
          <Results q={q} locale={locale} />
        </Suspense>
      ) : (
        <Start />
      )}
    </section>
  );
}
