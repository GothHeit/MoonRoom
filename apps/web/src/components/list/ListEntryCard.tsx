"use client";

import { useTranslations } from "next-intl";

import { PosterCard } from "@/components/ui/PosterCard";
import { animeHref, LIST_STATUSES, posterOf, type ListEntry } from "@/lib/catalog";
import { coverOf, MANGA_LIST_STATUSES, mangaHref, type MangaListEntry } from "@/lib/manga";

import { removeEntry, removeMangaEntry, setMangaStatus, setStatus } from "./listApi";
import { ListEntryMenu } from "./ListEntryMenu";

/** An anime poster with its episodes watched and a status/remove menu. */
export function ListEntryCard({ entry }: { entry: ListEntry }) {
  const t = useTranslations("list");
  const { node, list_status: status } = entry;
  const watched = status.num_episodes_watched ?? 0;
  const progress = node.num_episodes ? t("progress", { watched, total: node.num_episodes }) : t("progressUnknown", { watched });

  return (
    <ListEntryMenu title={node.title} statuses={LIST_STATUSES} current={status.status} move={(s) => setStatus(node.id, s)} remove={() => removeEntry(node.id)}>
      <PosterCard href={animeHref(node.id)} title={node.title} image={posterOf(node)} caption={progress} seed={node.id} />
    </ListEntryMenu>
  );
}

/** A manga cover with its chapters read and the same menu. */
export function MangaListEntryCard({ entry }: { entry: MangaListEntry }) {
  const t = useTranslations("list");
  const { node, list_status: status } = entry;
  const read = status.num_chapters_read ?? 0;
  const progress = node.num_chapters ? t("chapters", { read, total: node.num_chapters }) : t("chaptersUnknown", { read });

  return (
    <ListEntryMenu
      title={node.title}
      statuses={MANGA_LIST_STATUSES}
      current={status.status}
      move={(s) => setMangaStatus(node.id, s)}
      remove={() => removeMangaEntry(node.id)}
    >
      <PosterCard href={mangaHref(node.id)} title={node.title} image={coverOf(node)} caption={progress} seed={node.id} />
    </ListEntryMenu>
  );
}
