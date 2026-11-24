import { getTranslations } from "next-intl/server";

import { animeHref, captionOf, posterOf, progressFraction, watchHref, type HomeOut } from "@/lib/catalog";
import type { FriendRoomOut } from "@/lib/friends";
import { genreName } from "@/lib/genres";

import { TvPosterCard, TvRankedCard, TvRoomCard, TvWideCard } from "./TvCards";
import { TvRow } from "./TvRow";
import { tvHref } from "./paths";

// A TV chip lays out every card it is given: keep the page to what fits a few presses.
const MAX_ROWS = 8;
const MAX_ITEMS = 20;
/** Names on a room card; the rest of the room is counted after them. */
const NAMED = 3;

type Props = {
  rows: HomeOut["rows"];
  /** Rooms friends have open right now, shown first. */
  rooms?: FriendRoomOut[];
};

export async function TvHomeRows({ rows, rooms = [] }: Props) {
  const t = await getTranslations("home");
  const tGenres = await getTranslations("genres");
  const titleOf = (row: HomeOut["rows"][number]) => {
    if (row.genre) return t("rows.genre", { genre: genreName(tGenres, row.genre) });
    if (row.about) return t("rows.similar", { title: row.about.title });
    return t(`rows.${row.id}`);
  };
  return (
    <div className="space-y-4 pt-6">
      {rooms.length > 0 && (
        <TvRow title={t("rows.friendsRooms")} focusKey="row-friends-rooms">
          {rooms.slice(0, MAX_ITEMS).map((room) => {
            const names = room.people
              .slice(0, NAMED)
              .map((p) => p.username)
              .join(", ");
            const more = room.watching - Math.min(room.people.length, NAMED);
            const who = more > 0 ? t("friendsRoom.andMore", { names, count: more }) : names;
            return (
              <TvRoomCard
                key={room.code}
                focusKey={`row-friends-rooms-${room.code}`}
                href={tvHref(`/room/${room.code}`)}
                title={room.anime.title}
                image={posterOf(room.anime)}
                seed={room.anime.id}
                episode={t("episodeShort", { n: room.episode })}
                watching={t("friendsRoom.watching", { count: room.watching })}
                who={who}
                label={t("friendsRoom.join", { title: room.anime.title, names: who })}
              />
            );
          })}
        </TvRow>
      )}
      {rows.slice(0, MAX_ROWS).map((row) => {
        const key = row.genre ? `genre-${row.genre.id}` : row.about ? `similar-${row.about.id}` : row.id;
        return (
          <TvRow key={key} title={titleOf(row)} focusKey={`row-${key}`}>
            {row.items.slice(0, MAX_ITEMS).map(({ anime, progress, resume_episode }, i) => {
              const focusKey = `row-${key}-${anime.id}`;
              if (row.id === "continue_watching") {
                return (
                  <TvWideCard
                    key={anime.id}
                    focusKey={focusKey}
                    href={tvHref(resume_episode ? watchHref(anime.id, resume_episode) : animeHref(anime.id))}
                    title={anime.title}
                    image={posterOf(anime)}
                    caption={resume_episode ? t("episodeShort", { n: resume_episode }) : undefined}
                    progress={progress ? progressFraction(progress) : undefined}
                  />
                );
              }
              const card = { focusKey, href: tvHref(animeHref(anime.id)), title: anime.title, image: posterOf(anime), caption: captionOf(anime) };
              return row.id === "top" ? <TvRankedCard key={anime.id} rank={i + 1} {...card} /> : <TvPosterCard key={anime.id} {...card} />;
            })}
          </TvRow>
        );
      })}
    </div>
  );
}
