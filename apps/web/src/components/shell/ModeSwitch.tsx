"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";

import { counterpartOf, type Mode } from "./nav-items";

const MODES: Mode[] = ["anime", "manga"];

/** The "Anime | Manga" pill by the logo: which catalog the app shows. Each half is a link to the
 * same page on the other side (My list stays My list), so the choice is an address. */
export function ModeSwitch({ mode }: { mode: Mode }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <nav aria-label={t("catalog")} className="flex rounded-full border border-line-strong p-[3px]">
      {MODES.map((m) => {
        const active = m === mode;
        return (
          <Link
            key={m}
            href={counterpartOf(pathname, m)}
            aria-current={active ? "page" : undefined}
            className={`press flex min-h-8 items-center rounded-full px-3.5 text-[13px] font-bold leading-none ${
              active ? "bg-accent text-on-accent" : "text-muted hover:text-fg"
            }`}
          >
            {t(`mode.${m}`)}
          </Link>
        );
      })}
    </nav>
  );
}
