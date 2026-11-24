"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import {
  COMMENTS_ANCHOR,
  COMMENTS_COUNT_EVENT,
  COMMENTS_FIRST,
  COMMENTS_PAGE,
  type CommentsCountDetail,
  type CommentsPage,
  type TitleKind,
} from "@/lib/comments";

import { CommentList } from "./CommentList";
import { Composer } from "./Composer";
import { icons } from "./icons";
import { useComments, type CommentsSource } from "./useComments";

type Props = {
  kind: TitleKind;
  id: number;
  /** The first comments, loaded with the page; null when that failed and the browser should try. */
  initial: CommentsPage | null;
  /** The friends' progress line, rendered on the server. */
  friends: ReactNode;
};

function titleSource(kind: TitleKind, id: number): CommentsSource {
  return {
    list: (before, limit) => {
      const query = { limit, ...(before ? { before } : {}) };
      return kind === "anime"
        ? api.GET("/anime/{anime_id}/comments", { params: { path: { anime_id: id }, query } })
        : api.GET("/manga/{manga_id}/comments", { params: { path: { manga_id: id }, query } });
    },
    create: (body, spoiler) =>
      kind === "anime"
        ? api.POST("/anime/{anime_id}/comments", { params: { path: { anime_id: id } }, body: { body, spoiler } })
        : api.POST("/manga/{manga_id}/comments", { params: { path: { manga_id: id } }, body: { body, spoiler } }),
  };
}

/** Friends-only comments at the bottom of a title page: write box, newest first, "Show all". */
export function CommentsSection({ kind, id, initial, friends }: Props) {
  const t = useTranslations("comments");
  const params = useSearchParams();
  // A reply notice about a comment on the whole title points here (no episode or chapter).
  const focusId = params.get("ep") || params.get("ch") ? null : params.get("comment");
  const source = useMemo(() => titleSource(kind, id), [kind, id]);
  // The header link follows the count.
  const announce = useCallback(
    (total: number) => window.dispatchEvent(new CustomEvent<CommentsCountDetail>(COMMENTS_COUNT_EVENT, { detail: { kind, id, total } })),
    [kind, id],
  );
  const comments = useComments({ source, first: COMMENTS_FIRST, page: COMMENTS_PAGE, initial, onTotal: announce });
  const { items, total, state } = comments;

  // The comment a notice points at may be older than the first few: load the rest once.
  const fetchedForFocus = useRef(false);
  const found = !focusId || items.some((c) => c.id === focusId || c.replies?.some((r) => r.id === focusId));
  const { next, more } = comments;
  useEffect(() => {
    if (found || state !== "ready" || !next || fetchedForFocus.current) return;
    fetchedForFocus.current = true;
    void more();
  }, [found, state, next, more]);

  return (
    <section id={COMMENTS_ANCHOR} aria-label={t("heading")} className="max-w-[calc(48rem+4rem)] scroll-mt-24 px-4 sm:px-8">
      <h2 className="flex items-baseline gap-2.5 text-2xl sm:text-[1.75rem]">
        {t("heading")}
        {total > 0 && <span className="font-sans text-[15px] font-bold text-muted">{total}</span>}
      </h2>
      <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted">
        {icons.lock}
        {t("friendsOnly")}
      </p>
      {friends}
      <div className="mt-5">
        <Composer submitLabel={t("post")} label={t("label")} onSubmit={comments.post} />
      </div>

      {state === "loading" && (
        <p className="mt-6 text-sm text-muted" role="status">
          {t("loading")}
        </p>
      )}
      {state === "failed" && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <p className="text-sm text-soft">{t("failed")}</p>
          <Button variant="secondary" onClick={() => void comments.load()}>
            {t("retry")}
          </Button>
        </div>
      )}
      {state === "ready" && items.length === 0 && (
        <div className="mt-7 border-t border-line pt-7">
          <h3 className="font-display text-2xl font-normal">{t("emptyTitle")}</h3>
          <p className="mt-1.5 text-[15px] text-soft">{t("emptyBody")}</p>
        </div>
      )}
      <CommentList comments={comments} focusId={focusId} moreLabel={items.length <= COMMENTS_FIRST ? t("showAll", { count: total }) : t("showMore")} />
    </section>
  );
}
