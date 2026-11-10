"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { animeHref, captionOf, posterOf } from "@/lib/catalog";
import { coverOf, mangaCaption, mangaHref } from "@/lib/manga";

import { searchHrefFor, type Mode } from "./nav-items";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 6;

type Suggestion = { id: number; href: string; title: string; image: string | null; caption: string };

/** The active catalog's search, shaped the same way whichever it is. */
async function suggest(mode: Mode, q: string, signal: AbortSignal): Promise<Suggestion[]> {
  if (mode === "manga") {
    const { data } = await api.GET("/manga/search", { params: { query: { q } }, signal });
    return (data?.data ?? []).map((m) => ({ id: m.id, href: mangaHref(m.id), title: m.title, image: coverOf(m), caption: mangaCaption(m) }));
  }
  const { data } = await api.GET("/anime/search", { params: { query: { q } }, signal });
  return (data?.data ?? []).map((a) => ({ id: a.id, href: animeHref(a.id), title: a.title, image: posterOf(a), caption: captionOf(a) }));
}

/** Search field with an instant results dropdown. Enter opens the full results page of the active catalog. */
export function SearchBox({ mode = "anime" }: { mode?: Mode }) {
  const t = useTranslations("nav");
  const tSearch = useTranslations("search");
  const router = useRouter();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const q = query.trim();

  useEffect(() => {
    if (q.length < MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setResults((await suggest(mode, q, controller.signal)).slice(0, MAX_SUGGESTIONS));
        setActive(-1);
      } catch {
        // aborted by a newer keystroke, or the API is down: keep what is shown
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, mode]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const visible = open && q.length >= MIN_CHARS;
  const shown = q.length >= MIN_CHARS ? results : [];

  function go(href: string | { pathname: string; query: Record<string, string> }) {
    setOpen(false);
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!shown.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => {
        const n = i + step;
        return n < -1 ? shown.length - 1 : n >= shown.length ? -1 : n;
      });
    }
  }

  return (
    <div ref={root} className="relative">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (active >= 0 && shown[active]) go(shown[active].href);
          else if (q) go({ pathname: searchHrefFor(mode), query: { q } });
        }}
      >
        <input
          type="search"
          role="combobox"
          aria-expanded={visible}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={visible && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label={t("search")}
          placeholder={mode === "manga" ? t("searchManga") : t("searchPlaceholder")}
          className="h-9 w-40 rounded-full border border-line bg-surface px-4 text-sm placeholder:text-muted focus:border-accent lg:w-56 lg:focus:w-64"
        />
      </form>
      <ul
        id={listId}
        role="listbox"
        aria-label={tSearch("suggestions")}
        hidden={!visible}
        className="pop-in absolute right-0 top-full z-50 mt-2 w-80 origin-top-right overflow-hidden rounded-ui border border-line bg-surface shadow-lg shadow-black/50"
      >
        {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted">{tSearch("noSuggestions")}</li>}
        {shown.map((a, i) => (
          <li key={a.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
            <Link
              href={a.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 hover:bg-bg ${i === active ? "bg-bg" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- posters come from remote catalogs */}
              {a.image && <img src={a.image} alt="" width={32} height={48} loading="lazy" decoding="async" className="h-12 w-8 shrink-0 rounded-ui object-cover" />}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{a.title}</span>
                <span className="block text-xs text-muted">{a.caption}</span>
              </span>
            </Link>
          </li>
        ))}
        {q && (
          <li role="none" className="border-t border-line">
            <Link
              href={{ pathname: searchHrefFor(mode), query: { q } }}
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm font-bold text-accent hover:bg-bg"
            >
              {tSearch("viewAll")}
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
}
