"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { animeHref, LIST_STATUSES, posterOf, type ListEntry, type ListStatus } from "@/lib/catalog";

import { TvButton } from "./TvButton";
import { TvPosterCard } from "./TvCards";
import { TvGroup } from "./TvGroup";
import { tvHref } from "./paths";

// The status last picked, so Back from a title returns to the same tab (and card).
let lastStatus: ListStatus = "watching";
const rememberStatus = (status: ListStatus) => {
  lastStatus = status;
};

/** The MyAnimeList list: a status chip row over a poster grid, switched without a new request. */
export function TvListView({ entries }: { entries: ListEntry[] }) {
  const t = useTranslations("list");
  const [active, setActiveState] = useState<ListStatus>(lastStatus);
  const setActive = (status: ListStatus) => {
    rememberStatus(status);
    setActiveState(status);
  };
  const count = (s: ListStatus) => entries.filter((e) => e.list_status.status === s).length;
  const shown = entries.filter((e) => e.list_status.status === active);

  const progress = (e: ListEntry) =>
    e.node.num_episodes
      ? t("progress", { watched: e.list_status.num_episodes_watched, total: e.node.num_episodes })
      : t("progressUnknown", { watched: e.list_status.num_episodes_watched });

  return (
    <>
      <TvGroup top focusKey="tv-list-statuses">
        <div role="group" aria-label={t("tabs")} data-tv-scroller className="no-scrollbar flex gap-4 overflow-x-auto px-[var(--tv-x)] py-3">
          {LIST_STATUSES.map((s) => (
            <TvButton key={s} focusKey={`tv-status-${s}`} selected={s === active} onPress={() => setActive(s)} className="shrink-0">
              {t(`status.${s}`)}
              <span className="text-[1.5rem] font-medium tabular-nums">{count(s)}</span>
            </TvButton>
          ))}
        </div>
      </TvGroup>
      {shown.length === 0 ? (
        <p className="px-[var(--tv-x)] py-16 font-display text-[3rem]">{t("empty")}</p>
      ) : (
        // Remounted per status, so the remote sees the new cards (a focus key never changes in place).
        <TvGroup key={active} focusKey="tv-list-grid">
          <ul className="grid grid-cols-6 gap-x-8 gap-y-10 px-[var(--tv-x)] py-8">
            {shown.map((e) => (
              <li key={e.node.id}>
                <TvPosterCard
                  focusKey={`tv-list-${e.node.id}`}
                  href={tvHref(animeHref(e.node.id))}
                  title={e.node.title}
                  image={posterOf(e.node)}
                  caption={progress(e)}
                  className="w-full"
                />
              </li>
            ))}
          </ul>
        </TvGroup>
      )}
    </>
  );
}
