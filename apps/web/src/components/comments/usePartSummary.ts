"use client";

import { useEffect, useMemo, useState } from "react";

import type { CommentScope, UserSummary } from "@/lib/comments";

import { partSource, scopeKey } from "./partSource";

export type PartSummary = { total: number; locked: boolean; people: UserSummary[] };

/** How many friends' comments an episode or chapter has and who wrote some, for the player's
 * button and end card. Asks again whenever `refresh` changes (e.g. once the episode ends and
 * the comments open). Null until known, and on any failure: it is never worth an error. */
export function usePartSummary(scope: CommentScope | null, refresh: unknown = 0): PartSummary | null {
  const key = scope ? scopeKey(scope) : null;
  // Stable for one part, however the caller builds the scope object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => scope, [key]);
  const [summary, setSummary] = useState<{ key: string; value: PartSummary } | null>(null);

  useEffect(() => {
    if (!stable || !key) return;
    let live = true;
    partSource(stable)
      .list(null, 1)
      .then(
        ({ data }) => {
          if (!live || !data) return;
          const people = "people" in data ? data.people : [];
          setSummary({ key, value: { total: data.total, locked: "locked" in data ? data.locked : false, people } });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [stable, key, refresh]);

  return summary && summary.key === key ? summary.value : null;
}
