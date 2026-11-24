"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import type { components } from "@app/api-client";

import { placeholderFor } from "@/components/ui/PosterCard";
import { usePathname } from "@/i18n/navigation";
import { api } from "@/lib/api";
import type { ShareIn } from "@/lib/messages";

import { icons } from "./icons";
import { Sheet } from "./Sheet";

type Hit = { id: number; title: string; poster?: string | null };

type HomeRow = components["schemas"]["HomeRow"];
type MangaHomeRow = components["schemas"]["MangaHomeRow"];

const DEBOUNCE_MS = 300;
const SUGGESTIONS = 12;
// Sits over the button that opened it, at the bottom left of the chat.
const ANCHORED =
  "sm:absolute sm:inset-x-auto sm:bottom-[4.75rem] sm:left-3 sm:w-[24rem] sm:max-h-[min(34rem,calc(100%-6.5rem))] sm:origin-bottom-left md:left-6 short:bottom-2 short:left-2 short:w-[28rem] short:max-h-[calc(100%-1rem)]";

/** Find an anime or a manga and send it into the chat as a card. */
export function SharePicker({ onClose, onPick }: { onClose: () => void; onPick: (share: ShareIn) => Promise<boolean> }) {
  const t = useTranslations("messages");
  const fieldId = useId();
  const [kind, setKind] = useState<"anime" | "manga">(usePathname().startsWith("/manga") ? "manga" : "anime");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [suggested, setSuggested] = useState<{ anime?: Hit[]; manga?: Hit[] }>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [typing] = useState(() => typeof window.matchMedia === "function" && !window.matchMedia("(pointer: coarse)").matches);
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

  // Before anything is typed: what the viewer is in the middle of and what is on their list,
  // since that is what people share most. Other home rows fill in for a new account.
  useEffect(() => {
    if (suggested[kind]) return;
    let live = true;
    const first = ["continue_watching", "continue_reading", "my_list"];
    const rank = (rows: { id: string }[]) => [...rows].sort((a, b) => Number(first.includes(b.id)) - Number(first.includes(a.id)));
    const load =
      kind === "anime"
        ? api.GET("/home").then((r) => rank(r.data?.rows ?? []).flatMap((row) => (row as HomeRow).items.map((i) => i.anime)))
        : api.GET("/manga/home").then((r) => rank(r.data?.rows ?? []).flatMap((row) => (row as MangaHomeRow).items.map((i) => i.manga)));
    void load
      .catch(() => [])
      .then((cards) => {
        if (!live) return;
        const seen = new Set<number>();
        const unique = cards.filter((c) => !seen.has(c.id) && seen.add(c.id)).slice(0, SUGGESTIONS);
        setSuggested((all) => ({ ...all, [kind]: unique.map((c) => ({ id: c.id, title: c.title, poster: c.main_picture?.medium })) }));
      });
    return () => {
      live = false;
    };
  }, [kind, suggested]);

  async function pick(hit: Hit) {
    setBusy(hit.id);
    const sent = await onPick({ kind, id: hit.id });
    setBusy(null);
    if (sent) onClose();
  }

  const searching = q.length >= 2;
  const shown = searching ? hits : (suggested[kind] ?? null);

  return (
    <Sheet title={t("shareTitle")} onClose={onClose} desktop={ANCHORED}>
      <div className="sticky top-0 z-10 bg-surface px-4 pb-2 pt-1 sm:px-5 short:flex short:items-center short:gap-2">
        <div role="radiogroup" aria-label={t("shareTitle")} className="mb-2 inline-flex shrink-0 rounded-full border border-line-strong p-1 short:mb-0">
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
        <div className="relative text-muted short:min-w-0 short:flex-1">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">{icons.search}</span>
          <input
            id={fieldId}
            type="search"
            // On a phone the keyboard would cover the suggestions, so the field waits for a tap.
            autoFocus={typing}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={kind === "anime" ? t("searchAnime") : t("searchManga")}
            className="min-h-11 w-full rounded-full border border-line-strong bg-bg py-2 pl-11 pr-4 text-base text-fg placeholder:text-muted focus:border-accent focus-visible:outline-none! [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>
      {!shown && !searching && (
        <div aria-hidden="true" className="pb-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex min-h-16 items-center gap-3 px-4 py-2 sm:px-5">
              <span className="aspect-[2/3] w-10 animate-pulse rounded-ui bg-line" />
              <span className="h-4 w-40 animate-pulse rounded bg-line" />
            </div>
          ))}
        </div>
      )}
      {shown && shown.length === 0 && searching && <p className="px-5 py-6 text-center text-sm text-muted">{t("noResults")}</p>}
      {shown && shown.length > 0 && !searching && <p className="kicker px-4 pb-1 pt-2 sm:px-5">{t("suggested")}</p>}
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
