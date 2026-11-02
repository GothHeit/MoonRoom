"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { PosterGrid } from "@/components/grid/PosterGrid";
import { LIST_STATUSES, type ListEntry, type ListStatus } from "@/lib/catalog";
import { MANGA_LIST_STATUSES, type MangaListEntry, type MangaListStatus } from "@/lib/manga";

import { ListEntryCard, MangaListEntryCard } from "./ListEntryCard";

type Props = { kind: "anime"; entries: ListEntry[]; initial: ListStatus } | { kind: "manga"; entries: MangaListEntry[]; initial: MangaListStatus };

/** Status tabs over the whole list, so switching tabs needs no new request. The tab lives in the URL. */
export function ListView(props: Props) {
  const t = useTranslations("list");
  const [active, setActive] = useState<string>(props.initial);
  const statuses: readonly string[] = props.kind === "manga" ? MANGA_LIST_STATUSES : LIST_STATUSES;

  function select(status: string) {
    setActive(status);
    const url = new URL(window.location.href);
    url.searchParams.set("status", status);
    window.history.replaceState(null, "", url);
  }

  const count = (s: string) => props.entries.filter((e) => e.list_status.status === s).length;
  const cards =
    props.kind === "manga"
      ? props.entries.filter((e) => e.list_status.status === active).map((e) => <MangaListEntryCard key={e.node.id} entry={e} />)
      : props.entries.filter((e) => e.list_status.status === active).map((e) => <ListEntryCard key={e.node.id} entry={e} />);

  return (
    <>
      <div role="tablist" aria-label={t("tabs")} className="no-scrollbar -mx-4 mb-6 flex gap-1 overflow-x-auto px-4 sm:-mx-8 sm:px-8">
        {statuses.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            id={`list-tab-${s}`}
            aria-selected={s === active}
            aria-controls="list-panel"
            onClick={() => select(s)}
            className={`min-h-11 shrink-0 whitespace-nowrap border-b px-4 py-2 text-sm font-medium transition-colors ${s === active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {t(`status.${s}`)} <span className="text-xs">({count(s)})</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id="list-panel" aria-labelledby={`list-tab-${active}`}>
        {cards.length === 0 ? <p className="py-12 text-center text-muted">{t("empty")}</p> : <PosterGrid>{cards}</PosterGrid>}
      </div>
    </>
  );
}
