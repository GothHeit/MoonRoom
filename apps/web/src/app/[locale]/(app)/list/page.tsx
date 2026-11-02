import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { ListPage } from "@/components/list/ListPage";
import { titled } from "@/lib/page-title";

export async function generateMetadata({ params }: PageProps<"/[locale]/list">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "list" });
  return titled(t("title"));
}

export default async function AnimeListPage({ params, searchParams }: PageProps<"/[locale]/list">) {
  const { locale } = await params;
  return <ListPage kind="anime" locale={locale} status={(await searchParams).status} />;
}
