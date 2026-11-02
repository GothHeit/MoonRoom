"use client";

import { useTranslations } from "next-intl";

import { ButtonLink } from "@/components/ui/Button";
import type { Chapter } from "@/lib/manga";

type Props = {
  title: string;
  next: Chapter | null;
  nextHref: string | null;
  titleHref: string;
};

/** What the reader sees after the last page: on to the next chapter, or back to the title. */
export function EndCard({ title, next, nextHref, titleHref }: Props) {
  const t = useTranslations("reader");
  return (
    <div className="flex max-w-sm flex-col items-center gap-5 text-center" onClick={(e) => e.stopPropagation()} role="presentation">
      <p className="kicker">{title}</p>
      <h2 className="text-4xl sm:text-5xl">{t("end")}</h2>
      {next && nextHref ? (
        <ButtonLink href={nextHref} className="min-w-48">
          {next.number ? t("readNext", { n: next.number }) : t("nextChapter")}
        </ButtonLink>
      ) : (
        <p className="text-soft">{t("endOfTitle")}</p>
      )}
      <ButtonLink href={titleHref} variant="secondary">
        {t("backToTitle")}
      </ButtonLink>
    </div>
  );
}
