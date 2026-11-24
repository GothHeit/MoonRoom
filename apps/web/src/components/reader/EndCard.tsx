"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Faces } from "@/components/comments/CommentsPanel";
import type { PartSummary } from "@/components/comments/usePartSummary";
import { ButtonLink } from "@/components/ui/Button";
import type { Chapter } from "@/lib/manga";

type Props = {
  title: string;
  next: Chapter | null;
  nextHref: string | null;
  titleHref: string;
  /** Shown under the heading: the dropped-title prompt, when there is one. */
  children?: ReactNode;
  /** Friends' comments on the chapter just read, with a way to open them. */
  comments?: { summary: PartSummary; part: string; onOpen: () => void } | null;
};

/** What the reader sees after the last page: on to the next chapter, or back to the title. */
export function EndCard({ title, next, nextHref, titleHref, children, comments }: Props) {
  const t = useTranslations("reader");
  const tc = useTranslations("comments");
  return (
    <div className="flex max-w-sm flex-col items-center gap-5 text-center" onClick={(e) => e.stopPropagation()} role="presentation">
      <p className="kicker">{title}</p>
      <h2 className="text-4xl sm:text-5xl">{t("end")}</h2>
      {children}
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
      {comments && comments.summary.total > 0 && (
        <button type="button" onClick={comments.onOpen} className="press flex min-h-11 items-center gap-3 border-t border-line pt-4 text-left">
          <Faces people={comments.summary.people} size={24} />
          <span className="text-sm text-soft">{tc("friendLine", { count: comments.summary.total, part: comments.part })}</span>
          <span className="text-sm font-bold text-accent">{tc("read")}</span>
        </button>
      )}
    </div>
  );
}
