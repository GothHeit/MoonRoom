import { getTranslations } from "next-intl/server";

import { Avatar } from "@/components/ui/Avatar";
import { placeholderFor } from "@/components/ui/PosterCard";
import { Row } from "@/components/ui/Row";
import { Link } from "@/i18n/navigation";
import { posterOf } from "@/lib/catalog";
import type { FriendRoomOut } from "@/lib/friends";

const WIDE = "w-64 sm:w-80";
/** Faces and names on a card; the rest of the room is counted after them. */
const SHOWN = 3;

/** Rooms friends have open right now, one tap from joining. Renders nothing when there are none. */
export async function FriendsRooms({ rooms }: { rooms: FriendRoomOut[] }) {
  if (rooms.length === 0) return null;
  const t = await getTranslations("home");
  return (
    <div className="pt-8">
      <Row title={t("rows.friendsRooms")} itemClassName={WIDE}>
        {rooms.map((room) => {
          const image = posterOf(room.anime);
          const people = room.people.slice(0, SHOWN);
          const names = people.map((p) => p.username).join(", ");
          const more = room.watching - people.length;
          const who = more > 0 ? t("friendsRoom.andMore", { names, count: more }) : names;
          return (
            <Link key={room.code} href={`/room/${room.code}`} className="group block w-full" aria-label={t("friendsRoom.join", { title: room.anime.title, names: who })}>
              <div
                className={`relative aspect-video overflow-hidden rounded-ui transition-transform duration-200 ease-out group-hover:scale-[1.03] group-focus-visible:scale-[1.03] group-active:scale-[0.98] ${placeholderFor(room.anime.id)}`}
              >
                {image && (
                  // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from remote catalogs
                  <img src={image} alt="" width={320} height={180} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                )}
                <span className="absolute right-2.5 top-2.5 rounded-full bg-bg px-2.5 py-1 text-xs font-bold">{t("friendsRoom.watching", { count: room.watching })}</span>
              </div>
              <p className="mt-2.5 flex min-w-0 text-sm font-bold">
                <span className="truncate">{room.anime.title}</span>
                <span className="shrink-0 whitespace-pre text-muted">{` · ${t("episodeShort", { n: room.episode })}`}</span>
              </p>
              <div className="flex min-h-11 items-center gap-2.5">
                <span className="flex shrink-0">
                  {people.map((p, i) => (
                    // The narrow phone card keeps two faces so the names have room.
                    <span key={p.id} className={`rounded-full border-2 border-bg ${i > 0 ? "-ml-2" : ""} ${i > 1 ? "hidden sm:block" : ""}`}>
                      <Avatar userId={p.id} username={p.username} avatar={p.avatar} size={28} />
                    </span>
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted">{who}</span>
                <span aria-hidden="true" className="flex min-h-11 shrink-0 items-center rounded-full bg-accent px-5 text-sm font-bold text-on-accent">
                  {t("friendsRoom.joinShort")}
                </span>
              </div>
            </Link>
          );
        })}
      </Row>
    </div>
  );
}
