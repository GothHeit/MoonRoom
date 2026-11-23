import { cache } from "react";

import { COMMENTS_FIRST, type CommentsPage, type FriendReading, type FriendWatching, type TitleKind } from "@/lib/comments";
import { serverApi } from "@/lib/server-api";

/** The first comments of a title, shared by the header link and the section within one request.
 * Null when they couldn't be loaded: the section then tries again from the browser. */
export const firstComments = cache(async (kind: TitleKind, id: number): Promise<CommentsPage | null> => {
  try {
    const api = await serverApi();
    const query = { limit: COMMENTS_FIRST };
    const { data } =
      kind === "anime"
        ? await api.GET("/anime/{anime_id}/comments", { params: { path: { anime_id: id }, query } })
        : await api.GET("/manga/{manga_id}/comments", { params: { path: { manga_id: id }, query } });
    return data ?? null;
  } catch {
    return null;
  }
});

/** Friends' progress in a title. Empty on any failure: it is a nice-to-have, never an error. */
export async function friendsOnAnime(id: number): Promise<FriendWatching[]> {
  try {
    const { data } = await (await serverApi()).GET("/anime/{anime_id}/friends", { params: { path: { anime_id: id } } });
    return data ?? [];
  } catch {
    return [];
  }
}

export async function friendsOnManga(id: number): Promise<FriendReading[]> {
  try {
    const { data } = await (await serverApi()).GET("/manga/{manga_id}/friends", { params: { path: { manga_id: id } } });
    return data ?? [];
  } catch {
    return [];
  }
}
