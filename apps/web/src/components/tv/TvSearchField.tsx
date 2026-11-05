"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useRouter } from "@/i18n/navigation";

import { useTvFocus } from "./useTvFocus";

const DEBOUNCE_MS = 700;

/**
 * The search field. Focusing it with the remote opens the TV's keyboard; results follow the typing
 * after a short pause, and Enter searches at once. Down leaves for the results.
 */
export function TvSearchField({ initial }: { initial: string }) {
  const t = useTranslations("tv.search");
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const last = useRef(initial);

  const search = (q: string) => {
    const clean = q.trim().slice(0, 100);
    if (clean === last.current) return;
    last.current = clean;
    router.replace(clean ? `/tv/search?q=${encodeURIComponent(clean)}` : "/tv/search");
  };

  useEffect(() => {
    const timer = window.setTimeout(() => search(value), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `search` only reads refs and the router
  }, [value]);

  const { ref, focused } = useTvFocus<HTMLInputElement>({
    focusKey: "tv-search-input",
    onEnter: () => search(value),
    // Left and right belong to the text while typing.
    onArrow: (direction) => direction === "up" || direction === "down",
  });

  return (
    <label className="block">
      <span className="sr-only">{t("label")}</span>
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("placeholder")}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        className={`h-[5.5rem] w-full rounded-full border-2 bg-surface px-10 text-[2.25rem] text-fg outline-[3px] outline-offset-4 outline-solid outline-transparent transition-transform duration-[160ms] ease-out placeholder:text-muted ${
          focused ? "scale-[1.02] border-accent outline-accent" : "border-line-strong"
        }`}
      />
    </label>
  );
}
