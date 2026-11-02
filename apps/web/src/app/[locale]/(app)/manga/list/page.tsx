import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { ListPage } from "@/components/list/ListPage";
import { titled } from "@/lib/page-title";

export async function generateMetadata({ params }: PageProps<"/[locale]/manga/list">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "list" });
  return titled(`${t("title")} · ${t("kind.manga")}`);
}

export default async function MangaListPage({ params, searchParams }: PageProps<"/[locale]/manga/list">) {
  const { locale } = await params;
  return <ListPage kind="manga" locale={locale} status={(await searchParams).status} />;
}
