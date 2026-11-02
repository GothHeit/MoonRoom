import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { Pagination } from "@/components/grid/Pagination";
import { GridSkeleton, PosterGrid } from "@/components/grid/PosterGrid";
import { PosterCard } from "@/components/ui/PosterCard";
import { Link } from "@/i18n/navigation";
import { genreName } from "@/lib/genres";
import { coverOf, mangaCaption, mangaHref } from "@/lib/manga";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

const ROWS = ["top", "popular", "manhwa", "manhua", "oneshots", "favorites"] as const;
type RowId = (typeof ROWS)[number];
// As deep as the API lists a ranking.
const MAX_PAGE = 25;

type Filters = { row: RowId; genre?: number };

function parse(params: Record<string, string | string[] | undefined>, knownGenres: Set<number>) {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const rawRow = first(params.row);
  const row: RowId = ROWS.includes(rawRow as RowId) ? (rawRow as RowId) : "top";
  const rawGenre = Number(first(params.genre));
  const genre = knownGenres.has(rawGenre) ? rawGenre : undefined;
  const rawPage = Number(first(params.page));
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) : 1;
  return { filters: { row, genre } as Filters, page };
}

/** The address of a filtered view: a ranking and a genre are both links. */
function queryOf({ row, genre }: Filters) {
  const query: Record<string, string> = {};
  if (row !== "top") query.row = row;
  if (genre) query.genre = String(genre);
  return query;
}

const chip = (active: boolean) =>
  `press inline-flex min-h-11 shrink-0 items-center rounded-full border px-5 text-sm font-bold ${
    active ? "border-accent bg-accent text-on-accent" : "border-line-strong text-fg hover:border-accent"
  }`;
// On a phone the chips scroll sideways in one line; wider, they wrap.
const chips = "no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0";

async function Results({ filters, page, locale }: { filters: Filters; page: number; locale: string }) {
  const t = await getTranslations("manga.browse");
  const { data, has_next } = await unwrap(
    (await serverApi()).GET("/manga/browse", { params: { query: { ...filters, page } } }),
    locale,
  );
  if (data.length === 0) return <p className="py-12 text-center text-muted">{t("empty")}</p>;
  const query = queryOf(filters);
  return (
    <>
      <PosterGrid>
        {data.map((m) => (
          <PosterCard key={m.id} href={mangaHref(m.id)} title={m.title} image={coverOf(m)} caption={mangaCaption(m)} seed={m.id} />
        ))}
      </PosterGrid>
      <Pagination
        page={page}
        hasNext={has_next}
        hrefFor={(p) => ({ pathname: "/manga/browse", query: p > 1 ? { ...query, page: String(p) } : query })}
      />
    </>
  );
}

export async function generateMetadata({ params }: PageProps<"/[locale]/manga/browse">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "manga.browse" });
  return titled(t("title"));
}

export default async function MangaBrowsePage({ params, searchParams }: PageProps<"/[locale]/manga/browse">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tGenres, genres] = await Promise.all([
    getTranslations("manga.browse"),
    getTranslations("genres"),
    unwrap((await serverApi()).GET("/manga/genres"), locale),
  ]);
  const { filters, page } = parse(await searchParams, new Set(genres.map((g) => g.id)));
  const href = (next: Filters) => {
    const query = queryOf(next);
    return Object.keys(query).length ? { pathname: "/manga/browse" as const, query } : "/manga/browse";
  };

  return (
    <section className="px-4 pb-8 pt-24 sm:px-8">
      <h1 className="mb-5 text-4xl sm:text-5xl">{t("title")}</h1>
      {/* One chip per ranking, then one per genre. A chip is a link, so a filtered view is an address. */}
      <nav aria-label={t("rows")} className={chips}>
        {ROWS.map((id) => (
          <Link key={id} href={href({ ...filters, row: id })} aria-current={id === filters.row ? "page" : undefined} className={chip(id === filters.row)}>
            {t(id)}
          </Link>
        ))}
      </nav>
      <nav aria-label={t("genres")} className={`${chips} mt-3`}>
        <Link href={href({ row: filters.row })} aria-current={filters.genre ? undefined : "page"} className={chip(!filters.genre)}>
          {t("anyGenre")}
        </Link>
        {genres.map((g) => (
          <Link key={g.id} href={href({ ...filters, genre: g.id })} aria-current={g.id === filters.genre ? "page" : undefined} className={chip(g.id === filters.genre)}>
            {genreName(tGenres, g)}
          </Link>
        ))}
      </nav>
      <div className="mt-8">
        <Suspense key={`${filters.row}-${filters.genre ?? ""}-${page}`} fallback={<GridSkeleton />}>
          <Results filters={filters} page={page} locale={locale} />
        </Suspense>
      </div>
    </section>
  );
}
