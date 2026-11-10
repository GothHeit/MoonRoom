import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { resumePosition } from "@/components/player/progress";
import { styleOf } from "@/components/player/subtitleStyle";
import { TvPlayer } from "@/components/tv/player/TvPlayer";
import { APP_NAME } from "@/lib/brand";
import { serverApi, unwrap } from "@/lib/server-api";
import type { Lang } from "@/lib/watch-target";

type Params = PageProps<"/[locale]/tv/watch/[source]/[id]/[episode]">;

function parseIds(id: string, episode: string) {
  const animeId = Number(id);
  const ep = Number(episode);
  if (!Number.isInteger(animeId) || animeId < 1 || !Number.isInteger(ep) || ep < 0) notFound();
  return { animeId, ep };
}

const details = cache(async (id: number) =>
  (await serverApi()).GET("/anime/{anime_id}", { params: { path: { anime_id: id } } }),
);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id, episode, locale } = await params;
  const { animeId, ep } = parseIds(id, episode);
  const [{ data }, t] = await Promise.all([details(animeId), getTranslations({ locale, namespace: "player" })]);
  return { title: data ? `${data.title} · ${t("episode", { episode: ep })} · ${APP_NAME}` : APP_NAME };
}

/** The TV mode's player: the site's watch page, driven by the remote. */
export default async function TvWatchPage({ params, searchParams }: Params) {
  const { locale, source, id, episode } = await params;
  setRequestLocale(locale);
  const { animeId, ep } = parseIds(id, episode);
  const query = await searchParams;
  const lang: Lang = query.lang === "dub" ? "dub" : "sub";
  const api = await serverApi();

  const [anime, me, progressResult, episodesResult, preferences] = await Promise.all([
    unwrap(details(animeId), locale, "tv"),
    unwrap(api.GET("/me"), locale, "tv"),
    api.GET("/me/progress/{anime_id}", { params: { path: { anime_id: animeId } } }),
    // A failure here only hides the next-episode button; the player reports the real error.
    api
      .GET("/watch/{source}/{anime_id}/episodes", {
        params: { path: { source, anime_id: animeId }, query: { lang } },
      })
      .catch(() => undefined),
    api.GET("/watch/preferences").catch(() => undefined),
  ]);

  const t = Number(typeof query.t === "string" ? query.t : NaN);
  const saved = progressResult.data?.find((p) => p.episode === ep);
  const startAt = Number.isFinite(t) && t > 0 ? t : resumePosition(saved);
  const episodes = [...(episodesResult?.data?.episodes ?? [])].sort((a, b) => a - b);

  return (
    <TvPlayer
      key={`${source}-${animeId}-${ep}-${lang}`}
      source={source}
      animeId={animeId}
      episode={ep}
      title={anime.title}
      episodes={episodes}
      thumbnails={episodesResult?.data?.thumbnails ?? {}}
      poster={anime.main_picture?.large ?? anime.main_picture?.medium ?? null}
      lang={lang}
      startAt={startAt}
      subtitleLang={me.subtitle_lang}
      subtitleStyle={styleOf(preferences?.data)}
      showSkips={preferences?.data?.show_skip_buttons ?? true}
    />
  );
}
