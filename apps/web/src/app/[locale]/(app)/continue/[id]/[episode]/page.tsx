import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { pickStream } from "@/lib/pick-stream";
import { serverApi } from "@/lib/server-api";
import { pickEpisode, watchHref } from "@/lib/watch-target";

/**
 * Opens an episode without knowing its source, e.g. from a Continue watching card: picks the
 * source the user chose for this title in the player, else the first source that has it (see
 * pickStream), clamps the episode to what it lists and redirects to the player. Falls back to
 * the title page when nothing can play it.
 */
export default async function WatchAnyPage({ params }: PageProps<"/[locale]/continue/[id]/[episode]">) {
  const { locale, id: rawId, episode: rawEpisode } = await params;
  setRequestLocale(locale);
  const id = Number(rawId);
  const wanted = Number(rawEpisode);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(wanted) || wanted < 0) notFound();

  const api = await serverApi();
  const found = (
    await api.GET("/anime/{anime_id}/sources", { params: { path: { anime_id: id } } }).catch(() => undefined)
  )?.data;
  // The API lists the episodes of the stream it picked along with the sources; only ask for
  // them one by one when that came back empty.
  const inline =
    found?.stream && found.listing && found.listing.episodes.length > 0
      ? { choice: found.stream, listed: found.listing }
      : null;
  const picked =
    inline ??
    (await pickStream(found, async ({ source, lang }) =>
    (
      await api.GET("/watch/{source}/{anime_id}/episodes", {
        params: { path: { source, anime_id: id }, query: { lang } },
      })
    ).data,
  ));
  const episode = picked && pickEpisode(picked.listed.episodes, wanted);
  if (!picked || episode === null) return redirect({ href: `/anime/${id}`, locale });
  const { source, lang } = picked.choice;
  return redirect({ href: watchHref(source, id, episode, lang), locale });
}
