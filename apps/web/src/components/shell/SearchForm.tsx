"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { useRouter } from "@/i18n/navigation";

/** Phone search field for the search page; the nav bar has no room for one. Enter shows the results. */
export function SearchForm({ initial, pathname = "/search", placeholder }: { initial: string; pathname?: string; placeholder?: string }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const [value, setValue] = useState(initial);

  return (
    <form
      role="search"
      className="mb-6 md:hidden"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (q) router.push({ pathname, query: { q } });
      }}
    >
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={t("search")}
        placeholder={placeholder ?? t("searchPlaceholder")}
        className="h-11 w-full rounded-full border border-line bg-surface px-4 text-sm placeholder:text-muted focus:border-accent"
      />
    </form>
  );
}
