import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { SearchForm } from "@/components/shell/SearchForm";
import { GridSkeleton, PosterGrid } from "@/components/grid/PosterGrid";
import { ButtonLink } from "@/components/ui/Button";
import { PosterCard } from "@/components/ui/PosterCard";
import { animeHref, captionOf, posterOf } from "@/lib/catalog";
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
        <p className="text-muted">{t("prompt")}</p>
      )}
    </section>
  );
}
