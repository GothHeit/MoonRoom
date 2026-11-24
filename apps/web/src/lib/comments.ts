import type { components } from "@app/api-client";

export type CommentOut = components["schemas"]["CommentOut"];
export type CommentsPage = components["schemas"]["CommentsPage"];
export type FriendWatching = components["schemas"]["FriendWatching"];
export type FriendReading = components["schemas"]["FriendReading"];
export type TitleKind = "anime" | "manga";
export type UserSummary = components["schemas"]["UserSummary"];

export const COMMENT_MAX = 1000;
/** How many comments the title page shows before "Show all". */
export const COMMENTS_FIRST = 3;
export const COMMENTS_PAGE = 50;
export const COMMENTS_ANCHOR = "comments";

/** Fired when the viewer posts or deletes a comment, so the header link can follow the count. */
export const COMMENTS_COUNT_EVENT = "moonroom:comments-count";
export type CommentsCountDetail = { kind: TitleKind; id: number; total: number };

export type PartComments = components["schemas"]["PartComments"];
export type ReactionCount = components["schemas"]["ReactionCount"];
export type ReactionKind = ReactionCount["kind"];

/** The reactions anyone can leave, in the order they are offered and listed. */
export const REACTIONS: { kind: ReactionKind; emoji: string }[] = [
  { kind: "heart", emoji: "❤️" },
  { kind: "laugh", emoji: "😂" },
  { kind: "wow", emoji: "😮" },
  { kind: "cry", emoji: "😭" },
  { kind: "fire", emoji: "🔥" },
  { kind: "clap", emoji: "👏" },
];

/** Under a comment, replies past this many fold behind "View N more replies". */
export const REPLIES_SHOWN = 2;
/** Comments an episode or chapter panel loads at once. */
export const PART_PAGE = 20;

/** One episode or chapter whose comments are shown together. */
export type CommentScope = { kind: "episode"; animeId: number; episode: number } | { kind: "chapter"; mangaId: number; chapter: string };

/** Links to the title page with a part's comments open, the way reply notices link (see the
 * API's push.comment_path). */
export function commentHref(n: { anime_id?: number | null; manga_id?: number | null; episode?: number | null; chapter?: string | null; comment_id?: string | null }): string {
  const query = new URLSearchParams();
  if (n.comment_id) query.set("comment", n.comment_id);
  if (n.anime_id) {
    if (n.comment_id && n.episode != null) query.set("ep", String(n.episode));
    const q = query.toString();
    return `/anime/${n.anime_id}${q ? `?${q}` : ""}`;
  }
  if (n.manga_id) {
    if (n.comment_id && n.chapter != null) query.set("ch", n.chapter);
    const q = query.toString();
    return `/manga/${n.manga_id}${q ? `?${q}` : ""}`;
  }
  return "/";
}
