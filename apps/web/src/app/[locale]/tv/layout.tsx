import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";

import { TvOfflineWatch } from "@/components/tv/TvOfflineWatch";
import { TvRoot } from "@/components/tv/TvRoot";
import { APP_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: `TV · ${APP_NAME}` };

/** The TV mode: the site laid out for a television and its remote. */
export default async function TvLayout({
  children,
  params,
}: LayoutProps<"/[locale]/tv">) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <TvRoot>
      <TvOfflineWatch />
      {children}
    </TvRoot>
  );
}
