import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { styleOf } from "@/components/player/subtitleStyle";
import { TvRoom } from "@/components/tv/room/TvRoom";
import { TvRoomEnded } from "@/components/tv/room/TvRoomEnded";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

type Params = PageProps<"/[locale]/tv/room/[code]">;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "room" });
  return titled(t("panel"));
}

/** A friend's room on the TV: the TV player, kept in step with everyone in the room. */
export default async function TvRoomPage({ params }: Params) {
  const { locale, code } = await params;
  setRequestLocale(locale);
  const api = await serverApi();

  const [{ data: room, response }, me] = await Promise.all([
    api.GET("/watch/rooms/{code}", { params: { path: { code } } }),
    unwrap(api.GET("/me"), locale, "tv"),
  ]);
  if (response.status === 409) return <TvRoomEnded reason="room_full" />;
  // A card on Home can be a little old: the room may have ended since.
  if (!room) return <TvRoomEnded reason="room_not_found" />;

  const [episodes, preferences, anime] = await Promise.all([
    // Without the list there is no next episode; the player reports real errors itself.
    api
      .GET("/watch/{source}/{anime_id}/episodes", {
        params: { path: { source: room.source, anime_id: room.anime_id }, query: { lang: room.lang } },
      })
      .catch(() => undefined),
    api.GET("/watch/preferences").catch(() => undefined),
    // Only for the end screen's art.
    api.GET("/anime/{anime_id}", { params: { path: { anime_id: room.anime_id } } }).catch(() => undefined),
  ]);

  return (
    <TvRoom
      initial={room}
      meId={me.id}
      episodes={[...(episodes?.data?.episodes ?? [])].sort((a, b) => a - b)}
      thumbnails={episodes?.data?.thumbnails ?? {}}
      poster={anime?.data?.main_picture?.large ?? anime?.data?.main_picture?.medium ?? null}
      subtitleLang={me.subtitle_lang}
      subtitleStyle={styleOf(preferences?.data)}
      showSkips={preferences?.data?.show_skip_buttons ?? true}
    />
  );
}
