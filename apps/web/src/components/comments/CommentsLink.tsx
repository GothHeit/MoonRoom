"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { COMMENTS_ANCHOR, COMMENTS_COUNT_EVENT, type CommentsCountDetail, type TitleKind } from "@/lib/comments";

/** "N comments" in the title header, jumping to the section at the bottom. Hidden at zero. */
export function CommentsLink({ kind, id, total }: { kind: TitleKind; id: number; total: number }) {
  const t = useTranslations("comments");
  const [count, setCount] = useState(total);

  useEffect(() => {
    const onCount = (e: Event) => {
      const d = (e as CustomEvent<CommentsCountDetail>).detail;
      if (d.kind === kind && d.id === id) setCount(d.total);
    };
    window.addEventListener(COMMENTS_COUNT_EVENT, onCount);
    return () => window.removeEventListener(COMMENTS_COUNT_EVENT, onCount);
  }, [kind, id]);

  if (count < 1) return null;
  return (
    <li>
      <a href={`#${COMMENTS_ANCHOR}`} className="relative inline-flex items-center gap-1.5 text-accent after:absolute after:-inset-x-2 after:-inset-y-3 hover:underline">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z" />
        </svg>
        {t("count", { count })}
      </a>
    </li>
  );
}
