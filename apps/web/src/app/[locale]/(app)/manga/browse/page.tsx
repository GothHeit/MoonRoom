import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { Pagination } from "@/components/grid/Pagination";
import { GridSkeleton, PosterGrid } from "@/components/grid/PosterGrid";
import { PosterCard } from "@/components/ui/PosterCard";
import { Link } from "@/i18n/navigation";
import { coverOf, mangaCaption, mangaHref } from "@/lib/manga";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

const ROWS = ["top", "popular", "manhwa", "manhua", "oneshots"] as const;
type RowId = (typeof ROWS)[number];
// As deep as the API lists a ranking.
const MAX_PAGE = 25;

function parse(params: Record<string, string | string[] | undefined>) {
  const rawRow = Array.isArray(params.row) ? params.row[0] : params.row;
  const row: RowId = ROWS.includes(rawRow as RowId) ? (rawRow as RowId) : "top";
  const rawPage = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) : 1;
  return { row, page };
}

async function Results({ row, page, locale }: { row: RowId; page: number; locale: string }) {
  const t = await getTranslations("manga.browse");
  const { data, has_next } = await unwrap(
    (await serverApi()).GET("/manga/browse", { params: { query: { row, page } } }),
    locale,
  );
  if (data.length === 0) return <p className="py-12 text-center text-muted">{t("empty")}</p>;
  const query: Record<string, string> = row === "top" ? {} : { row };
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
  const t = await getTranslations("manga.browse");
  const { row, page } = parse(await searchParams);

  return (
    <section className="px-4 pb-8 pt-24 sm:px-8">
      <h1 className="mb-5 text-4xl sm:text-5xl">{t("title")}</h1>
      {/* One chip per ranking. A chip is a link, so a ranking is an address. */}
      <nav aria-label={t("rows")} className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {ROWS.map((id) => {
          const active = id === row;
          return (
            <Link
              key={id}
              href={id === "top" ? "/manga/browse" : { pathname: "/manga/browse", query: { row: id } }}
              aria-current={active ? "page" : undefined}
              className={`press inline-flex min-h-11 shrink-0 items-center rounded-full border px-5 text-sm font-bold ${
                active ? "border-accent bg-accent text-on-accent" : "border-line-strong text-fg hover:border-accent"
              }`}
            >
              {t(id)}
            </Link>
          );
        })}
      </nav>
      <div className="mt-8">
        <Suspense key={`${row}-${page}`} fallback={<GridSkeleton />}>
          <Results row={row} page={page} locale={locale} />
        </Suspense>
      </div>
    </section>
  );
}
