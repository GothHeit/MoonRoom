"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import { placeholderFor } from "@/components/ui/PosterCard";
import { usePathname } from "@/i18n/navigation";
import { api } from "@/lib/api";
import type { ShareIn } from "@/lib/messages";

import { icons } from "./icons";
import { Sheet } from "./Sheet";

type Hit = { id: number; title: string; poster?: string | null };

const DEBOUNCE_MS = 300;

/** Find an anime or a manga and send it into the chat as a card. */
export function SharePicker({ onClose, onPick }: { onClose: () => void; onPick: (share: ShareIn) => Promise<boolean> }) {
  const t = useTranslations("messages");
  const fieldId = useId();
  const [kind, setKind] = useState<"anime" | "manga">(usePathname().startsWith("/manga") ? "manga" : "anime");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(async () => {
      const found =
        kind === "anime"
          ? await api.GET("/anime/search", { params: { query: { q } } }).then((r) => r.data?.data, () => undefined)
          : await api.GET("/manga/search", { params: { query: { q } } }).then((r) => r.data?.data, () => undefined);
      if (!live) return;
      setHits((found ?? []).slice(0, 20).map((n) => ({ id: n.id, title: n.title, poster: n.main_picture?.medium })));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, kind]);

  async function pick(hit: Hit) {
    setBusy(hit.id);
    const sent = await onPick({ kind, id: hit.id });
    setBusy(null);
    if (sent) onClose();
  }

  const shown = q.length >= 2 ? hits : null;

  return (
    <Sheet title={t("shareTitle")} onClose={onClose}>
      <div className="sticky top-0 z-10 bg-surface px-4 pb-2 pt-1 sm:px-5">
        <div role="radiogroup" aria-label={t("shareTitle")} className="mb-2 inline-flex rounded-full border border-line-strong p-1">
          {(["anime", "manga"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => {
                setKind(k);
                setHits(null);
              }}
              className={`press min-h-11 rounded-full px-4 text-sm font-bold ${kind === k ? "bg-accent text-on-accent" : "text-soft"}`}
            >
              {t(k)}
            </button>
          ))}
        </div>
        <label htmlFor={fieldId} className="sr-only">
          {kind === "anime" ? t("searchAnime") : t("searchManga")}
        </label>
        <div className="relative text-muted">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">{icons.search}</span>
          <input
            id={fieldId}
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={kind === "anime" ? t("searchAnime") : t("searchManga")}
            className="min-h-11 w-full rounded-full border border-line-strong bg-bg py-2 pl-11 pr-4 text-base text-fg placeholder:text-muted focus:border-accent [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>
      {shown && shown.length === 0 && <p className="px-5 py-6 text-center text-sm text-muted">{t("noResults")}</p>}
      {shown && shown.length > 0 && (
        <ul className="pb-3">
          {shown.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => void pick(hit)}
                disabled={busy !== null}
                className="press flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left hover:bg-line/40 disabled:opacity-60 sm:px-5"
              >
                <span className={`relative block aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-ui ${placeholderFor(hit.id)}`}>
                  {hit.poster && (
                    // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
                    <img src={hit.poster} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                  )}
                </span>
                <span className="min-w-0 flex-1 font-medium leading-snug">{hit.title}</span>
                <span className="text-muted">{busy === hit.id ? "…" : icons.send}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
