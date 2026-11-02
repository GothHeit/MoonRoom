"use client";

import { useEffect, useRef } from "react";

import { api } from "@/lib/api";

const SAVE_DELAY_MS = 800;

/** Saves the page the reader is on, a moment after it settles, and once more when the reader leaves. */
export function useReadProgress(mangaId: number, chapterKey: string, page: number, pages: number) {
  const latest = useRef({ page, pages });
  const saved = useRef<number | null>(null);

  useEffect(() => {
    latest.current = { page, pages };
    if (pages === 0) return;
    const timer = setTimeout(() => {
      if (saved.current === page) return;
      saved.current = page;
      void api.PUT("/manga/{manga_id}/progress/{chapter}", {
        params: { path: { manga_id: mangaId, chapter: chapterKey } },
        body: { page, pages, completed: page >= pages - 1 },
      });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [mangaId, chapterKey, page, pages]);

  useEffect(() => {
    return () => {
      const { page: last, pages: count } = latest.current;
      if (count === 0 || saved.current === last) return;
      // Leaving mid-chapter: fire and forget, the browser keeps a keepalive request alive.
      void fetch(`/api/proxy/manga/${mangaId}/progress/${encodeURIComponent(chapterKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: last, pages: count, completed: last >= count - 1 }),
        keepalive: true,
      }).catch(() => undefined);
    };
  }, [mangaId, chapterKey]);
}
