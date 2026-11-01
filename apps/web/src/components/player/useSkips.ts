"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";

import { mergeSkips, type Skip } from "./skips";

/**
 * The skip buttons: the source's own skips plus those from AniSkip, which are asked once the
 * episode's length is known (0 until then).
 */
export function useSkips(ownSkips: Skip[], animeId: number, episode: number, length: number) {
  // Extra skips only hold for the answer they were fetched with; a new answer starts over.
  const [extra, setExtra] = useState<{ own: Skip[]; skips: Skip[] }>({ own: ownSkips, skips: [] });

  useEffect(() => {
    if (!length) return;
    let cancelled = false;
    api
      .GET("/watch/skips/{anime_id}/{episode}", {
        params: { path: { anime_id: animeId, episode }, query: { length } },
      })
      .then(({ data }) => !cancelled && data && setExtra({ own: ownSkips, skips: data }))
      // Without them only the source's own skips are offered.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [animeId, episode, length, ownSkips]);

  return useMemo(
    () => mergeSkips(ownSkips, extra.own === ownSkips ? extra.skips : []),
    [ownSkips, extra],
  );
}
