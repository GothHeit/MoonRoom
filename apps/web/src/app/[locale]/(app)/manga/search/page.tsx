import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { GridSkeleton, PosterGrid } from "@/components/grid/PosterGrid";
import { SearchForm } from "@/components/shell/SearchForm";
import { ButtonLink } from "@/components/ui/Button";
import { PosterCard } from "@/components/ui/PosterCard";
import { coverOf, mangaCaption, mangaHref } from "@/lib/manga";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

async function Results({ q, locale }: { q: string; locale: string }) {
  const t = await getTranslations("manga.search");
  const { data } = await unwrap((await serverApi()).GET("/manga/search", { params: { query: { q } } }), locale);
  if (data.length === 0) return <p className="py-12 text-center text-muted">{t("empty", { q })}</p>;
  return (
    <PosterGrid>
      {data.map((m) => (
        <PosterCard key={m.id} href={mangaHref(m.id)} title={m.title} image={coverOf(m)} caption={mangaCaption(m)} seed={m.id} />
      ))}
    </PosterGrid>
  );
}

function query(raw: string | string[] | undefined) {
  return (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 100) ?? "";
}

export async function generateMetadata({ params, searchParams }: PageProps<"/[locale]/manga/search">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "manga.search" });
  const q = query((await searchParams).q);
  return titled(q ? t("resultsFor", { q }) : t("title"));
}

export default async function MangaSearchPage({ params, searchParams }: PageProps<"/[locale]/manga/search">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("manga.search");
  const tNav = await getTranslations("nav");
  const q = query((await searchParams).q);

  return (
    <section className="px-4 pb-8 pt-24 sm:px-8">
      <h1 className="mb-6 text-4xl sm:text-5xl">{q ? t("resultsFor", { q }) : t("title")}</h1>
      <SearchForm key={q} initial={q} pathname="/manga/search" placeholder={tNav("searchManga")} />
      {q ? (
        <Suspense key={q} fallback={<GridSkeleton />}>
          <Results q={q} locale={locale} />
        </Suspense>
      ) : (
        <div className="flex flex-col items-start gap-6">
          <p className="text-soft">{t("prompt")}</p>
          <ButtonLink href="/manga/browse" variant="secondary">
            {t("browse")}
          </ButtonLink>
        </div>
      )}
    </section>
  );
}
