"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { Button } from "@/components/ui/Button";
import { PART_PAGE, type CommentScope, type UserSummary } from "@/lib/comments";

import { CommentList } from "./CommentList";
import { Composer } from "./Composer";
import { icons } from "./icons";
import { partSource } from "./partSource";
import { useComments } from "./useComments";

type Props = {
  scope: CommentScope;
  /** The title's name, shown above the heading. */
  title: string;
  onClose: () => void;
  /** A comment to bring into view, e.g. the one a reply notice points at. */
  focusId?: string | null;
  /** Told the count once it is known and whenever it changes. */
  onTotal?: (total: number, locked: boolean) => void;
};

/** "junior, pondofe and claudia" in the viewer's language. */
export function useNames() {
  const format = useFormatter();
  return (people: UserSummary[]) => format.list(people.map((p) => p.username), { type: "conjunction" });
}

export function Faces({ people, size = 28 }: { people: UserSummary[]; size?: number }) {
  return (
    <span className="flex shrink-0">
      {people.map((p, i) => (
        <span key={p.id} className={`rounded-full ring-2 ring-surface ${i > 0 ? "-ml-2" : ""}`}>
          <Avatar userId={p.id} username={p.username} avatar={p.avatar} size={size} />
        </span>
      ))}
    </span>
  );
}

/** The comments on one episode or chapter: a side panel on larger screens, a bottom sheet on
 * phones. Until the viewer has finished that part it only says who commented. */
export function CommentsPanel({ scope, title, onClose, focusId, onTotal }: Props) {
  const t = useTranslations("comments");
  const names = useNames();
  const source = useMemo(() => partSource(scope), [scope]);
  const comments = useComments({ source, first: PART_PAGE, page: PART_PAGE });
  const { items, total, state, locked, people } = comments;
  const onTotalRef = useRef(onTotal);
  useEffect(() => {
    onTotalRef.current = onTotal;
  });
  useEffect(() => {
    if (state === "ready") onTotalRef.current?.(total, locked);
  }, [state, total, locked]);
  const part = scope.kind === "episode" ? t("episode", { n: scope.episode }) : t("chapter", { n: scope.chapter });

  // Escape closes, and the page behind doesn't scroll while the panel is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <>
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-black/70" />
      <BottomSheet
        label={t("panelLabel", { part })}
        onClose={onClose}
        className="fixed inset-x-0 bottom-0 top-[max(3.5rem,calc(env(safe-area-inset-top)+1rem))] z-50 flex flex-col rounded-t-2xl border-t border-line-strong bg-bg text-fg sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:top-0 sm:w-[30rem] sm:origin-right sm:rounded-none sm:border-l sm:border-t-0 sm:border-line"
      >
        {({ dismiss, handleProps }) => (
          <>
            <div {...handleProps} className={`border-b border-line px-4 pb-3 pt-2 sm:px-6 sm:pt-5 ${handleProps.className}`}>
              <span aria-hidden="true" className="mx-auto mb-2 block h-1 w-10 rounded-full bg-line-strong sm:hidden" />
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="kicker truncate">
                    {title} · {part}
                  </p>
                  <h2 className="mt-1 flex items-baseline gap-2.5 text-3xl leading-none">
                    {t("heading")}
                    {total > 0 && <span className="font-sans text-sm font-bold text-muted">{total}</span>}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={dismiss}
                  aria-label={t("close")}
                  className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg hover:border-accent"
                >
                  {icons.close}
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
              {state === "loading" && (
                <p className="text-sm text-muted" role="status">
                  {t("loading")}
                </p>
              )}
              {state === "failed" && (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-soft">{t("failed")}</p>
                  <Button variant="secondary" onClick={() => void comments.load()}>
                    {t("retry")}
                  </Button>
                </div>
              )}
              {state === "ready" && locked && (
                <div className="pt-4">
                  {people.length > 0 && <Faces people={people} size={36} />}
                  <h3 className="mt-4 font-display text-[1.75rem] font-normal leading-tight">{t(scope.kind === "episode" ? "lockedEpisode" : "lockedChapter")}</h3>
                  <p className="mt-2 text-[15px] text-soft">
                    {total > 0 ? t("lockedBody", { names: names(people), count: total }) : t("lockedEmpty")}
                  </p>
                </div>
              )}
              {state === "ready" && !locked && (
                <>
                  <p className="mb-4 flex items-center gap-1.5 text-[13px] text-muted">
                    {icons.lock}
                    {t(scope.kind === "episode" ? "finishedOnlyEpisode" : "finishedOnlyChapter")}
                  </p>
                  <Composer submitLabel={t("post")} label={t("label")} placeholder={t(scope.kind === "episode" ? "placeholderEpisode" : "placeholderChapter")} onSubmit={comments.post} />
                  {items.length === 0 && (
                    <div className="mt-7 border-t border-line pt-7">
                      <h3 className="font-display text-2xl font-normal">{t("emptyTitle")}</h3>
                      <p className="mt-1.5 text-[15px] text-soft">{t("emptyBody")}</p>
                    </div>
                  )}
                  <CommentList comments={comments} focusId={focusId} moreLabel={t("showMore")} />
                </>
              )}
            </div>
          </>
        )}
      </BottomSheet>
    </>
  );
}
