import { api } from "@/lib/api";
import type { CommentScope } from "@/lib/comments";

import type { CommentsSource } from "./useComments";

/** Reading and writing the comments on one episode or chapter. */
export function partSource(scope: CommentScope): CommentsSource {
  if (scope.kind === "episode") {
    const path = { anime_id: scope.animeId, episode: scope.episode };
    return {
      list: (before, limit) => api.GET("/anime/{anime_id}/episodes/{episode}/comments", { params: { path, query: { limit, ...(before ? { before } : {}) } } }),
      create: (body, spoiler) => api.POST("/anime/{anime_id}/episodes/{episode}/comments", { params: { path }, body: { body, spoiler } }),
    };
  }
  const path = { manga_id: scope.mangaId, chapter: scope.chapter };
  return {
    list: (before, limit) => api.GET("/manga/{manga_id}/chapters/{chapter}/comments", { params: { path, query: { limit, ...(before ? { before } : {}) } } }),
    create: (body, spoiler) => api.POST("/manga/{manga_id}/chapters/{chapter}/comments", { params: { path }, body: { body, spoiler } }),
  };
}

export function scopeKey(scope: CommentScope): string {
  return scope.kind === "episode" ? `e:${scope.animeId}:${scope.episode}` : `c:${scope.mangaId}:${scope.chapter}`;
}
