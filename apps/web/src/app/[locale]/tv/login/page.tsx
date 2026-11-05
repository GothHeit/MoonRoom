import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TvLogin } from "@/components/tv/TvLogin";
import { TvPage } from "@/components/tv/TvPage";
import { titled } from "@/lib/page-title";

export async function generateMetadata({ params }: PageProps<"/[locale]/tv/login">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tv.login" });
  return titled(t("title"));
}

export default async function TvLoginPage({ params }: PageProps<"/[locale]/tv/login">) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <TvPage bare initial="tv-login-password">
      <TvLogin />
    </TvPage>
  );
}
