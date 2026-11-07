import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import { tvHref } from "@/components/tv/paths";
import { redirect } from "@/i18n/navigation";
import { continueIds, continueTarget } from "@/lib/continue-target";

/** The TV mode's Continue watching: the same pick as the site's, opened in the TV player. */
export default async function TvWatchAnyPage({ params }: PageProps<"/[locale]/tv/continue/[id]/[episode]">) {
  const { locale, id: rawId, episode: rawEpisode } = await params;
  setRequestLocale(locale);
  const ids = continueIds(rawId, rawEpisode);
  if (!ids) notFound();
  const href = await continueTarget(ids.id, ids.wanted);
  return redirect({ href: tvHref(href ?? `/anime/${ids.id}`), locale });
}
