import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { continueIds, continueTarget } from "@/lib/continue-target";

/**
 * Opens an episode without knowing its source, e.g. from a Continue watching card, in the
 * player (see continueTarget). Falls back to the title page when nothing can play it.
 */
export default async function WatchAnyPage({ params }: PageProps<"/[locale]/continue/[id]/[episode]">) {
  const { locale, id: rawId, episode: rawEpisode } = await params;
  setRequestLocale(locale);
  const ids = continueIds(rawId, rawEpisode);
  if (!ids) notFound();
  const href = await continueTarget(ids.id, ids.wanted);
  return redirect({ href: href ?? `/anime/${ids.id}`, locale });
}
