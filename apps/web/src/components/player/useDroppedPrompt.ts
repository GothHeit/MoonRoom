"use client";

import { useCallback, useState } from "react";

import { api } from "@/lib/api";
import type { ListKind } from "@/lib/catalog";

/**
 * Finishing an episode (or a chapter) of a title the user dropped on MyAnimeList asks whether to
 * move it back to watching (reading). The server leaves dropped titles alone, so this is the only
 * thing that changes them.
 */
export function useDroppedPrompt(titleId: number, kind: ListKind = "anime") {
  const [asking, setAsking] = useState(false);

  const check = useCallback(() => {
    const entry =
      kind === "manga"
        ? api.GET("/me/mangalist/{manga_id}", { params: { path: { manga_id: titleId } } })
        : api.GET("/me/animelist/{anime_id}", { params: { path: { anime_id: titleId } } });
    entry
      .then(({ data }) => {
        if (data?.linked && data.status === "dropped") setAsking(true);
      })
      .catch(() => undefined);
  }, [titleId, kind]);

  const accept = useCallback(() => {
    setAsking(false);
    const update =
      kind === "manga"
        ? api.PATCH("/me/mangalist/{manga_id}", { params: { path: { manga_id: titleId } }, body: { status: "reading" } })
        : api.PATCH("/me/animelist/{anime_id}", { params: { path: { anime_id: titleId } }, body: { status: "watching" } });
    update.catch(() => undefined);
  }, [titleId, kind]);

  const dismiss = useCallback(() => setAsking(false), []);

  return { asking, check, accept, dismiss };
}
