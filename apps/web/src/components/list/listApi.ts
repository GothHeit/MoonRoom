"use client";

import { errorCode } from "@app/api-client";

import { api } from "@/lib/api";
import type { ListStatus } from "@/lib/catalog";
import type { MangaListStatus } from "@/lib/manga";

/** Each helper returns null on success or the API error code. */
async function run(call: Promise<{ error?: unknown; response: Response }>): Promise<string | null> {
  try {
    const { error, response } = await call;
    return response.ok ? null : errorCode(error);
  } catch {
    return "network";
  }
}

export const setStatus = (animeId: number, status: ListStatus) =>
  run(api.PATCH("/me/animelist/{anime_id}", { params: { path: { anime_id: animeId } }, body: { status } }));

export const removeEntry = (animeId: number) =>
  run(api.DELETE("/me/animelist/{anime_id}", { params: { path: { anime_id: animeId } } }));

export const setMangaStatus = (mangaId: number, status: MangaListStatus) =>
  run(api.PATCH("/me/mangalist/{manga_id}", { params: { path: { manga_id: mangaId } }, body: { status } }));

export const removeMangaEntry = (mangaId: number) =>
  run(api.DELETE("/me/mangalist/{manga_id}", { params: { path: { manga_id: mangaId } } }));
