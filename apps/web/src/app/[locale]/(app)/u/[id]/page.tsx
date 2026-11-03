import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";

import { Avatar } from "@/components/ui/Avatar";
import { ButtonLink } from "@/components/ui/Button";
import { PosterCard } from "@/components/ui/PosterCard";
import { Row } from "@/components/ui/Row";
import { CoverCard } from "@/components/manga/CoverCard";
import { animeHref, posterOf } from "@/lib/catalog";
import { genreName } from "@/lib/genres";
import { coverOf, mangaHref } from "@/lib/manga";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

// One poster size for every row, and rows pulled out to the page edge so their headings line up with the stats grid.
const ITEM = "w-32 sm:w-40";
const BLEED = "-mx-4 sm:-mx-8";

export async function generateMetadata({ params }: PageProps<"/[locale]/u/[id]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "profile" });
  return titled(t("title"));
}

export default async function ProfilePage({ params }: PageProps<"/[locale]/u/[id]">) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("profile");
  const tGenres = await getTranslations("genres");
  const format = await getFormatter();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const api = await serverApi();

  // Anyone who isn't a friend gets a 403: say so, rather than showing an error page.
  const result = await api.GET("/users/{user_id}/profile", { params: { path: { user_id: id } } });
  if (result.response.status === 403) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-4 pb-8 pt-24 sm:px-8">
        <h1 className="text-4xl sm:text-5xl">{t("locked")}</h1>
        <p className="text-muted">{t("lockedHint")}</p>
        <ButtonLink href="/friends">{t("toFriends")}</ButtonLink>
      </div>
    );
  }
  const profile = await unwrap(Promise.resolve(result), locale);
  const { user } = profile;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  const shared = profile.stats && profile.watching && profile.recent;
  const mangaStats = profile.manga_stats;
  const reading = profile.reading ?? [];
  const recentManga = profile.recent_manga ?? [];
  const hasManga = !!mangaStats && mangaStats.titles > 0;
  const hasAnime = (profile.watching?.length ?? 0) > 0 || (profile.recent?.length ?? 0) > 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 pb-8 pt-24 sm:px-8">
      <header className="flex flex-wrap items-center gap-5">
        <Avatar userId={user.id} username={user.username} avatar={user.avatar} size={96} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-4xl sm:text-5xl">{user.username}</h1>
          <p className="text-sm text-muted">
            {t("joined", { date: date(profile.joined_at) })}
            {profile.friends_since && ` · ${t("friendsSince", { date: date(profile.friends_since) })}`}
          </p>
        </div>
        {profile.relation === "self" && (
          <ButtonLink href="/settings" variant="secondary">
            {t("edit")}
          </ButtonLink>
        )}
      </header>

      {!shared ? (
        <p className="text-muted">{profile.relation === "self" ? t("ownPrivate") : t("private", { name: user.username })}</p>
      ) : (
        <>
          {profile.relation === "self" && !profile.activity_shared && <p className="text-muted">{t("ownPrivate")}</p>}
          <dl className="grid grid-cols-3 gap-3">
            {(["titles", "episodes", "friends"] as const).map((key) => (
              <div key={key} className="rounded-ui border border-line bg-surface p-4">
                <dd className="text-2xl font-bold">{format.number(profile.stats![key])}</dd>
                <dt className="text-sm text-muted">{t(`stats.${key}`)}</dt>
              </div>
            ))}
          </dl>
          {profile.watching!.length > 0 && (
            <Row title={t("watching")} itemClassName={ITEM} className={BLEED}>
              {profile.watching!.map(({ anime, episode }) => (
                <PosterCard key={anime.id} href={animeHref(anime.id)} title={anime.title} image={posterOf(anime)} caption={t("episode", { n: episode })} />
              ))}
            </Row>
          )}
          {profile.recent!.length > 0 && (
            <Row title={t("recent")} itemClassName={ITEM} className={BLEED}>
              {profile.recent!.map(({ anime, episode }) => (
                <PosterCard key={anime.id} href={animeHref(anime.id)} title={anime.title} image={posterOf(anime)} caption={t("finished", { n: episode })} />
              ))}
            </Row>
          )}
          {!hasAnime && !hasManga && <p className="text-muted">{t("emptyWatching")}</p>}
          {hasManga && (
            <section aria-labelledby="manga-heading" className="flex flex-col gap-6 border-t border-line pt-8">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <h2 id="manga-heading" className="text-3xl">
                  {t("manga")}
                </h2>
                {!!profile.manga_genres?.length && (
                  <ul className="flex flex-wrap gap-2" aria-label={t("favoriteGenres")}>
                    {profile.manga_genres.map((g) => (
                      <li key={g.id} className="rounded-full border border-line-strong px-3 py-1 text-xs">
                        {genreName(tGenres, g)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-3">
                {(["titles", "chapters"] as const).map((key) => (
                  <div key={key} className="rounded-ui border border-line bg-surface p-4">
                    <dd className="text-2xl font-bold">{format.number(mangaStats[key])}</dd>
                    <dt className="text-sm text-muted">{t(`mangaStats.${key}`)}</dt>
                  </div>
                ))}
              </dl>
              {reading.length > 0 && (
                <Row title={t("reading")} itemClassName={ITEM} className={BLEED}>
                  {reading.map(({ manga, chapter, page, pages }) => (
                    <CoverCard
                      key={manga.id}
                      href={mangaHref(manga.id)}
                      title={manga.title}
                      image={coverOf(manga)}
                      seed={manga.id}
                      caption={t("chapter", { n: chapter })}
                      progress={pages > 0 ? (page + 1) / pages : undefined}
                    />
                  ))}
                </Row>
              )}
              {recentManga.length > 0 && (
                <Row title={t("recentManga")} itemClassName={ITEM} className={BLEED}>
                  {recentManga.map(({ manga, chapter }) => (
                    <CoverCard
                      key={manga.id}
                      href={mangaHref(manga.id)}
                      title={manga.title}
                      image={coverOf(manga)}
                      seed={manga.id}
                      caption={t("chapter", { n: chapter })}
                    />
                  ))}
                </Row>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
