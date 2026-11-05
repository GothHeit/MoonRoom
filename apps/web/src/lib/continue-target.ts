import { pickStream } from "@/lib/pick-stream";
import { serverApi } from "@/lib/server-api";
import { pickEpisode, watchHref } from "@/lib/watch-target";

/**
 * The player address for episode `wanted` of a title whose source isn't known, e.g. from a
 * Continue watching card: the source the user chose for this title in the player, else the first
 * source that has it (see pickStream), with the episode clamped to what it lists. Null when
 * nothing can play it.
 */
export async function continueTarget(id: number, wanted: number): Promise<string | null> {
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
  if (!picked || episode === null) return null;
  const { source, lang } = picked.choice;
  return watchHref(source, id, episode, lang);
}

/** The ids of a /continue address, or null when they aren't valid. */
export function continueIds(rawId: string, rawEpisode: string): { id: number; wanted: number } | null {
  const id = Number(rawId);
  const wanted = Number(rawEpisode);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(wanted) || wanted < 0) return null;
  return { id, wanted };
}
