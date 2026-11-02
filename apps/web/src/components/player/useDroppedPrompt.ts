"use client";

import { useCallback, useState } from "react";

import { api } from "@/lib/api";

/**
 * Finishing an episode of a title the user dropped on MyAnimeList asks whether to move it back to
 * watching. The server leaves dropped titles alone, so this is the only thing that changes them.
 */
export function useDroppedPrompt(animeId: number) {
  const [asking, setAsking] = useState(false);

  const check = useCallback(() => {
    api
      .GET("/me/animelist/{anime_id}", { params: { path: { anime_id: animeId } } })
      .then(({ data }) => {
        if (data?.linked && data.status === "dropped") setAsking(true);
      })
      .catch(() => undefined);
  }, [animeId]);

  const accept = useCallback(() => {
    setAsking(false);
    api
      .PATCH("/me/animelist/{anime_id}", {
        params: { path: { anime_id: animeId } },
        body: { status: "watching" },
      })
      .catch(() => undefined);
  }, [animeId]);

  const dismiss = useCallback(() => setAsking(false), []);

  return { asking, check, accept, dismiss };
}
