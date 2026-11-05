import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TvPage } from "@/components/tv/TvPage";
import { TvSettings } from "@/components/tv/TvSettings";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

export async function generateMetadata({ params }: PageProps<"/[locale]/tv/settings">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tv.settings" });
  return titled(t("title"));
}

export default async function TvSettingsPage({ params }: PageProps<"/[locale]/tv/settings">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("tv.settings");
  const me = await unwrap((await serverApi()).GET("/me"), locale, "tv");
  return (
    <TvPage initial={`tv-locale-${locale}`}>
      <h1 className="px-[var(--tv-x)] pb-4 pt-10 text-[4rem]">{t("title")}</h1>
      <TvSettings username={me.username} showNsfw={me.show_nsfw} />
    </TvPage>
  );
}
