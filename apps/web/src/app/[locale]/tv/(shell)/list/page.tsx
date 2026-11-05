import { errorCode } from "@app/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { TvListView } from "@/components/tv/TvListView";
import { TvPage } from "@/components/tv/TvPage";
import { TvGridSkeleton } from "@/components/tv/TvSkeleton";
import { toApiError } from "@/lib/errors";
import { titled } from "@/lib/page-title";
import { expiredSessionPath, serverApi, unwrap } from "@/lib/server-api";

/** Linking MyAnimeList needs a browser sign-in, so the TV only points to the phone or computer. */
async function NotLinked({ expired }: { expired?: boolean }) {
  const t = await getTranslations("tv.list");
  return (
    <div className="px-[var(--tv-x)] py-16">
      <h2 className="text-[3.5rem]">{expired ? t("expiredTitle") : t("unlinkedTitle")}</h2>
      <p className="mt-4 max-w-[52rem] text-[1.75rem] text-soft">{t("unlinkedBody")}</p>
    </div>
  );
}

async function Entries({ locale }: { locale: string }) {
  const api = await serverApi();
  const { connected } = await unwrap(api.GET("/me/mal"), locale, "tv");
  if (!connected) return <NotLinked />;
  const { data, error, response } = await api.GET("/me/animelist", { params: { query: {} } });
  if (data !== undefined) return <TvListView entries={data.data} />;
  const code = errorCode(error);
  if (code === "mal_session_expired" || code === "mal_not_linked") return <NotLinked expired={code === "mal_session_expired"} />;
  if (response.status === 401) redirect(expiredSessionPath(locale, "tv"));
  throw toApiError(response.status, error);
}

export async function generateMetadata({ params }: PageProps<"/[locale]/tv/list">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "list" });
  return titled(t("title"));
}

export default async function TvListPage({ params }: PageProps<"/[locale]/tv/list">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("list");
  return (
    <TvPage initial="tv-status-watching">
      <h1 className="px-[var(--tv-x)] pb-6 pt-10 text-[4rem]">{t("title")}</h1>
      <Suspense fallback={<TvGridSkeleton />}>
        <Entries locale={locale} />
      </Suspense>
    </TvPage>
  );
}
