import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cache, Suspense } from "react";

import { ChapterList } from "@/components/manga/ChapterList";
import { MangaHeader } from "@/components/manga/MangaHeader";
import { ButtonLink } from "@/components/ui/Button";
import { PosterCard } from "@/components/ui/PosterCard";
import { Row } from "@/components/ui/Row";
import { Skeleton } from "@/components/ui/Skeleton";
import { APP_NAME } from "@/lib/brand";
import { coverOf, mangaHref, readAction } from "@/lib/manga";
import { serverApi, unwrap } from "@/lib/server-api";

type Params = PageProps<"/[locale]/manga/[id]">;

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) notFound();
  return id;
}

// The metadata and the page share one details call per request.
const details = cache(async (id: number) => (await serverApi()).GET("/manga/{manga_id}", { params: { path: { manga_id: id } } }));

// Shared by the badge and the list, so the sources are asked once.
const chapters = cache(async (id: number, lang: string | undefined) => {
  const { data } = await (await serverApi()).GET("/manga/{manga_id}/chapters", { params: { path: { manga_id: id }, query: { lang } } });
  return data ?? null;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const { data } = await details(parseId(id));
  return { title: data ? `${data.title} · ${APP_NAME}` : APP_NAME };
}

async function ReadBadge({ id, lang }: { id: number; lang?: string }) {
  const [listing, t] = await Promise.all([chapters(id, lang), getTranslations("manga.page")]);
  const here = !!listing?.chapters?.length;
  return (
    <p className={`inline-block self-start rounded-full border px-3 py-0.5 text-xs font-bold ${here ? "border-accent text-accent" : "border-line-strong text-muted"}`}>
      {here ? t("readHere") : t("trackingOnly")}
    </p>
  );
}

/** The primary pill: start, continue or read the next chapter. Nothing when no source has the title. */
async function ReadAction({ id, lang }: { id: number; lang?: string }) {
  const [listing, t] = await Promise.all([chapters(id, lang), getTranslations("manga.page")]);
  const action = listing && readAction(listing, id);
  if (!action) return null;
  return (
    <ButtonLink href={action.href}>
      <span aria-hidden="true">▶</span>
      {t(action.key, { n: action.n })}
    </ButtonLink>
  );
}

// As wide as the real pill ("Continue · Ch. 128") so nothing shifts when it arrives.
function ActionSkeleton() {
  return <Skeleton className="h-11 w-44 rounded-full" />;
}

function BadgeSkeleton() {
  return <div aria-hidden="true" className="h-6 w-24 self-start animate-pulse rounded-ui bg-surface" />;
}

/** Holds the list's place (the pill, the heading and a few rows) while the source answers. */
function ChaptersSkeleton() {
  return (
    <section aria-hidden="true" className="px-4 sm:px-8">
      <Skeleton className="mb-4 h-11 w-48 rounded-full" />
      <Skeleton className="mb-3 h-8 w-32" />
      <div className="divide-y divide-line">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex min-h-14 items-center justify-between py-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    </section>
  );
}

async function Chapters({ id, lang }: { id: number; lang?: string }) {
  const [listing, t] = await Promise.all([chapters(id, lang), getTranslations("manga.page")]);
  if (!listing) return <p className="px-4 text-muted sm:px-8">{t("trackingOnlyHint")}</p>;
  return <ChapterList mangaId={id} listing={listing} />;
}

export default async function MangaPage({ params, searchParams }: Params) {
  const { locale, id: rawId } = await params;
  setRequestLocale(locale);
  const id = parseId(rawId);
  const rawLang = (await searchParams).lang;
  const lang = (Array.isArray(rawLang) ? rawLang[0] : rawLang)?.slice(0, 10) || undefined;
  const t = await getTranslations("manga.page");
  const manga = await unwrap(details(id), locale);
  const related = manga.related_manga ?? [];
  const recommendations = manga.recommendations ?? [];

  // The chapters come from a source that can be slow: the page renders without them and the
  // parts that need them stream in.
  return (
    <>
      <MangaHeader
        manga={manga}
        badge={
          <Suspense fallback={<BadgeSkeleton />}>
            <ReadBadge id={id} lang={lang} />
          </Suspense>
        }
        action={
          <Suspense fallback={<ActionSkeleton />}>
            <ReadAction id={id} lang={lang} />
          </Suspense>
        }
      />
      <div className="flex flex-col gap-10 py-6">
        <Suspense key={lang ?? ""} fallback={<ChaptersSkeleton />}>
          <Chapters id={id} lang={lang} />
        </Suspense>
        {related.length > 0 && (
          <Row title={t("related")}>
            {related.map((r) => (
              <PosterCard
                key={`${r.relation_type}-${r.manga.id}`}
                href={mangaHref(r.manga.id)}
                title={r.manga.title}
                image={coverOf(r.manga)}
                caption={r.relation_type_formatted}
                seed={r.manga.id}
              />
            ))}
          </Row>
        )}
        {recommendations.length > 0 && (
          <Row title={t("recommended")}>
            {recommendations.map((r) => (
              <PosterCard key={r.manga.id} href={mangaHref(r.manga.id)} title={r.manga.title} image={coverOf(r.manga)} seed={r.manga.id} />
            ))}
          </Row>
        )}
      </div>
    </>
  );
}
