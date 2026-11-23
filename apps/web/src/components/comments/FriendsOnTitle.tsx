import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Link } from "@/i18n/navigation";
import type { FriendReading, FriendWatching } from "@/lib/comments";
import { profileHref, type UserSummary } from "@/lib/friends";

import { friendsOnAnime, friendsOnManga } from "./data";

const SHOWN_AVATARS = 3;
const NAMED = 2;

type Entry = { user: UserSummary; line: ReactNode };

/** Avatars of friends who watched (or read) this title and one line on where the first two are.
 * Renders nothing when no friend has started it. */
export async function FriendsOnTitle({ kind, id, last }: { kind: "anime" | "manga"; id: number; last?: number | null }) {
  const t = await getTranslations("comments.friends");
  const b = (chunks: ReactNode) => <b className="font-bold text-fg">{chunks}</b>;
  let entries: Entry[];
  if (kind === "anime") {
    const friends: FriendWatching[] = await friendsOnAnime(id);
    entries = friends.map((f) => ({
      user: f.user,
      line:
        f.completed && last && f.episode >= last
          ? t.rich("finished", { name: f.user.username, b })
          : t.rich("onEpisode", { name: f.user.username, episode: f.episode, b }),
    }));
  } else {
    const friends: FriendReading[] = await friendsOnManga(id);
    entries = friends.map((f) => ({
      user: f.user,
      line:
        f.completed && last && Number(f.chapter) >= last
          ? t.rich("finished", { name: f.user.username, b })
          : t.rich("onChapter", { name: f.user.username, chapter: f.chapter, b }),
    }));
  }
  if (!entries.length) return null;
  const rest = entries.length - NAMED;
  const sep = (
    <span aria-hidden="true" className="mx-1.5 text-numeral">
      ·
    </span>
  );

  return (
    <div className="mt-5 flex items-center gap-3">
      <ul className="flex shrink-0" aria-label={t(kind === "anime" ? "labelAnime" : "labelManga")}>
        {entries.slice(0, SHOWN_AVATARS).map((e, i) => (
          <li key={e.user.id} className={i ? "-ml-2" : ""}>
            <Link
              href={profileHref(e.user.id)}
              aria-label={e.user.username}
              className="press block rounded-full ring-2 ring-bg hover:ring-accent"
            >
              <Avatar userId={e.user.id} username={e.user.username} avatar={e.user.avatar} size={32} />
            </Link>
          </li>
        ))}
      </ul>
      <p className="min-w-0 text-sm leading-snug text-soft">
        {entries.slice(0, NAMED).map((e, i) => (
          <span key={e.user.id}>
            {i > 0 && sep}
            {e.line}
          </span>
        ))}
        {rest > 0 && (
          <>
            {sep}
            <span className="text-muted">{t("more", { count: rest })}</span>
          </>
        )}
      </p>
    </div>
  );
}
