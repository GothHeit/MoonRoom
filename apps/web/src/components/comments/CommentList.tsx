"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { CommentOut } from "@/lib/comments";

import { CommentItem } from "./CommentItem";
import type { CommentsState } from "./useComments";

type Props = {
  comments: CommentsState;
  /** Label for the button that loads the rest, given how many are hidden. */
  moreLabel: string;
  focusId?: string | null;
};

/** The loaded comments, newest first, the button that loads more, and the delete question. */
export function CommentList({ comments, moreLabel, focusId }: Props) {
  const t = useTranslations("comments");
  const [deleting, setDeleting] = useState<CommentOut | null>(null);
  const { items, next, total, loadingMore } = comments;

  return (
    <>
      {items.length > 0 && (
        <ul className="mt-2">
          {items.map((c) => (
            <CommentItem key={c.id} comment={c} actions={comments} onDelete={setDeleting} focusId={focusId} />
          ))}
        </ul>
      )}
      {next && total > items.length && (
        <Button variant="secondary" className="mt-1" disabled={loadingMore} onClick={() => void comments.more()}>
          {moreLabel}
        </Button>
      )}

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={t("deleteTitle")}>
        <p className="text-soft">{deleting?.replies?.length ? t("deleteWithReplies") : t("deleteBody")}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            {t("cancel")}
          </Button>
          <Button
            variant="secondary"
            className="text-danger hover:border-danger"
            onClick={async () => {
              if (deleting && (await comments.remove(deleting))) setDeleting(null);
            }}
          >
            {t("delete")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
