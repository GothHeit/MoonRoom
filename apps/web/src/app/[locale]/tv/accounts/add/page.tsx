import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TvLogin } from "@/components/tv/TvLogin";
import { TvPage } from "@/components/tv/TvPage";
import { titled } from "@/lib/page-title";

export async function generateMetadata({ params }: PageProps<"/[locale]/tv/accounts/add">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tv.accounts" });
  return titled(t("addTitle"));
}

export default async function TvAddAccountPage({ params }: PageProps<"/[locale]/tv/accounts/add">) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <TvPage bare initial="tv-login-cancel">
      <TvLogin adding />
    </TvPage>
  );
}
