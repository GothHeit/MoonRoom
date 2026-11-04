import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { styleOf } from "@/components/player/subtitleStyle";
import { RoomClient } from "@/components/room/RoomClient";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

export async function generateMetadata({ params }: PageProps<"/[locale]/room/[code]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "room" });
  return titled(t("panel"));
}

export default async function RoomPage({ params, searchParams }: PageProps<"/[locale]/room/[code]">) {
  const { locale, code } = await params;
  const { debug } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("room");
  const api = await serverApi();

  const [{ data: room, response }, me] = await Promise.all([
    api.GET("/watch/rooms/{code}", { params: { path: { code } } }),
    unwrap(api.GET("/me"), locale),
  ]);
  if (response.status === 409) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black p-6 text-center text-fg">
        <p role="alert" className="max-w-md text-lg font-medium">
          {t("closed.room_full")}
        </p>
      </div>
    );
  }
  if (!room) notFound();

  const [episodes, preferences] = await Promise.all([
    // Without the list the episode picker stays hidden; the player reports real errors itself.
    api
      .GET("/watch/{source}/{anime_id}/episodes", {
        params: { path: { source: room.source, anime_id: room.anime_id }, query: { lang: room.lang } },
      })
      .catch(() => undefined),
    api.GET("/watch/preferences").catch(() => undefined),
  ]);

  return (
    <RoomClient
      initial={room}
      meId={me.id}
      episodes={[...(episodes?.data?.episodes ?? [])].sort((a, b) => a - b)}
      subtitleLang={me.subtitle_lang}
      subtitleStyle={styleOf(preferences?.data)}
      showSkips={preferences?.data?.show_skip_buttons ?? true}
      debug={debug === "sync"}
    />
  );
}
