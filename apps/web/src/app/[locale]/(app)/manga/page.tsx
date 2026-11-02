import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { MangaRows } from "@/components/manga/MangaRows";
import { Skeleton } from "@/components/ui/Skeleton";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

/** Holds the rows' place: a heading and a line of covers per row. */
function RowsSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-10 py-8">
      {Array.from({ length: 3 }, (_, r) => (
        <div key={r}>
          <Skeleton className="mb-4 ml-4 h-8 w-56 sm:ml-8" />
          <div className="no-scrollbar flex gap-3 overflow-hidden px-4 sm:gap-5 sm:px-8">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="w-36 shrink-0 sm:w-44">
                <Skeleton className="aspect-[2/3] w-full" />
                <Skeleton className="mt-2.5 h-4 w-3/4" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

async function HomeContent({ locale }: { locale: string }) {
  const t = await getTranslations("manga");
  const home = await unwrap((await serverApi()).GET("/manga/home"), locale);
  if (home.rows.length === 0) return <p className="px-4 pb-24 pt-8 text-muted sm:px-8">{t("empty")}</p>;
  return <MangaRows rows={home.rows} />;
}

export async function generateMetadata({ params }: PageProps<"/[locale]/manga">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "manga" });
  return titled(t("title"));
}

export default async function MangaHome({ params }: PageProps<"/[locale]/manga">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("manga");
  return (
    <>
      <h1 className="px-4 pt-24 text-4xl sm:px-8 sm:pt-28 sm:text-5xl">{t("title")}</h1>
      <Suspense fallback={<RowsSkeleton />}>
        <HomeContent locale={locale} />
      </Suspense>
    </>
  );
}
