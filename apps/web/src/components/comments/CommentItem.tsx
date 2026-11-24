"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Link } from "@/i18n/navigation";
import { REACTIONS, REPLIES_SHOWN, type CommentOut, type ReactionKind } from "@/lib/comments";
import { profileHref } from "@/lib/friends";
import { usePresence } from "@/lib/use-presence";

import { Composer } from "./Composer";
import { icons } from "./icons";
import { OwnMenu } from "./OwnMenu";
import type { CommentsState } from "./useComments";

type Actions = Pick<CommentsState, "save" | "reply" | "react">;

type Props = {
  comment: CommentOut;
  actions: Actions;
  onDelete: (comment: CommentOut) => void;
  /** A comment to bring into view and mark, e.g. the one a reply notice points at. */
  focusId?: string | null;
};

/** The six reactions, offered in a row of round buttons. */
function Picker({ comment, onPick, onClose }: { comment: CommentOut; onPick: (kind: ReactionKind) => void; onClose: () => void }) {
  const t = useTranslations("comments");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div ref={root} role="group" aria-label={t("react")} className="pop-in mt-2 inline-flex origin-top-left flex-wrap gap-0.5 rounded-full border border-line-strong bg-surface p-1">
      {REACTIONS.map(({ kind, emoji }) => {
        const mine = comment.reactions?.some((r) => r.kind === kind && r.mine) ?? false;
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={mine}
            aria-label={t(`reactions.${kind}`)}
            onClick={() => onPick(kind)}
            className={`press flex h-11 w-11 items-center justify-center rounded-full text-[22px] leading-none hover:bg-line ${mine ? "bg-line" : ""}`}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}

/** Reaction counts, the button that offers more, and Reply. */
function Footer({ comment, actions, onReply }: { comment: CommentOut; actions: Actions; onReply?: () => void }) {
  const t = useTranslations("comments");
  const [picking, setPicking] = useState(false);
  const presence = usePresence(picking);
  const pick = (kind: ReactionKind) => {
    setPicking(false);
    void actions.react(comment, kind);
  };

  return (
    <div>
      <div className="-ml-1 mt-1.5 flex flex-wrap items-center gap-1.5">
        {(comment.reactions ?? []).map((r) => {
          const emoji = REACTIONS.find((x) => x.kind === r.kind)?.emoji;
          return (
            <button
              key={r.kind}
              type="button"
              aria-pressed={r.mine}
              aria-label={t("reactionCount", { reaction: t(`reactions.${r.kind}`), count: r.count })}
              onClick={() => void actions.react(comment, r.kind)}
              className={`press inline-flex h-9 min-w-11 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[13px] font-bold tabular-nums ${
                r.mine ? "border-accent bg-line text-accent" : "border-line text-soft hover:border-line-strong"
              }`}
            >
              <span className="text-[15px] leading-none">{emoji}</span>
              {r.count}
            </button>
          );
        })}
        <button
          type="button"
          aria-label={t("react")}
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
          className="press inline-flex h-9 w-11 items-center justify-center rounded-full border border-line text-muted hover:border-line-strong hover:text-fg"
        >
          {icons.smile}
        </button>
        {onReply && (
          <button type="button" onClick={onReply} className="press inline-flex h-11 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-bold text-muted hover:text-fg">
            {icons.reply}
            {t("reply")}
          </button>
        )}
      </div>
      {presence.mounted && <Picker comment={comment} onPick={pick} onClose={() => setPicking(false)} />}
    </div>
  );
}

/** One comment or reply: who, when, the text (or its spoiler cover), and what can be done to it. */
function Body({ comment, actions, onDelete, onReply, small, focused }: Omit<Props, "focusId"> & { onReply?: () => void; small?: boolean; focused?: boolean }) {
  const t = useTranslations("comments");
  const format = useFormatter();
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const hidden = comment.spoiler && !comment.mine && !revealed;
  // Never "in 2 seconds" when this device's clock runs behind the server's.
  const now = new Date();
  const created = new Date(Math.min(Date.parse(comment.created_at), now.getTime()));
  const size = small ? 28 : 40;

  return (
    <div id={`comment-${comment.id}`} className={`flex scroll-mt-24 gap-3 ${small ? "py-2.5" : ""} ${focused ? "rounded-ui outline-2 outline-offset-4 outline-accent" : ""}`}>
      <Link href={profileHref(comment.user.id)} aria-label={comment.user.username} className="press shrink-0 self-start rounded-full" style={{ height: size }}>
        <Avatar userId={comment.user.id} username={comment.user.username} avatar={comment.user.avatar} size={size} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-bold text-fg">{comment.mine ? t("you") : comment.user.username}</span>
            <span className="text-xs text-muted">
              <time dateTime={comment.created_at} title={format.dateTime(created, { dateStyle: "medium", timeStyle: "short" })} suppressHydrationWarning>
                {format.relativeTime(created, now)}
              </time>
              {comment.edited_at && ` · ${t("edited")}`}
              {comment.spoiler && comment.mine && ` · ${t("spoiler")}`}
            </span>
          </p>
          {comment.mine && !editing && <OwnMenu onEdit={() => setEditing(true)} onDelete={() => onDelete(comment)} />}
        </div>
        {editing ? (
          <div className="mt-2">
            <Composer
              initialText={comment.body}
              initialSpoiler={comment.spoiler}
              spoilerSwitch={!small}
              submitLabel={t("save")}
              label={t("editLabel")}
              autoFocus
              onCancel={() => setEditing(false)}
              onSubmit={async (text, spoiler) => {
                const saved = await actions.save(comment, text, spoiler);
                if (saved) setEditing(false);
                return saved;
              }}
            />
          </div>
        ) : hidden ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="press mt-2 flex min-h-11 w-full items-center gap-2 rounded-ui border border-dashed border-line-strong px-3.5 text-left text-sm font-medium text-muted hover:border-accent hover:text-fg"
          >
            {icons.eyeOff}
            {t("reveal")}
          </button>
        ) : (
          <p className={`mt-1 whitespace-pre-line leading-relaxed text-soft [overflow-wrap:anywhere] ${small ? "text-sm" : "text-[15px]"}`}>{comment.body}</p>
        )}
        {!editing && !hidden && <Footer comment={comment} actions={actions} onReply={onReply} />}
      </div>
    </div>
  );
}

/** A comment with the replies under it, folded after the first few, and a box to answer. */
export function CommentItem({ comment, actions, onDelete, focusId }: Props) {
  const t = useTranslations("comments");
  const replies = comment.replies ?? [];
  const focusIsReply = replies.findIndex((r) => r.id === focusId);
  const [expanded, setExpanded] = useState(focusIsReply >= REPLIES_SHOWN);
  const [replying, setReplying] = useState<string | null>(null);
  const shown = expanded ? replies : replies.slice(0, REPLIES_SHOWN);
  const folded = replies.length - shown.length;
  const replyTo = replies.find((r) => r.id === replying) ?? (replying === comment.id ? comment : null);

  // Bring the comment a notice points at into view once it is on screen.
  useEffect(() => {
    if (!focusId) return;
    if (focusId !== comment.id && focusIsReply < 0) return;
    document.getElementById(`comment-${focusId}`)?.scrollIntoView({ block: "center" });
  }, [focusId, comment.id, focusIsReply]);

  return (
    <li className="border-b border-line py-4 last:border-b-0">
      <Body comment={comment} actions={actions} onDelete={onDelete} onReply={() => setReplying(comment.id)} focused={focusId === comment.id} />
      {(replies.length > 0 || replyTo) && (
        <div className="ml-5 mt-2 border-l border-line-strong pl-4 sm:ml-[3.25rem]">
          {shown.map((r) => (
            <Body key={r.id} comment={r} actions={actions} onDelete={onDelete} onReply={() => setReplying(r.id)} small focused={focusId === r.id} />
          ))}
          {folded > 0 && (
            <button type="button" onClick={() => setExpanded(true)} className="press min-h-11 text-sm font-bold text-accent hover:underline">
              {t("moreReplies", { count: folded })}
            </button>
          )}
          {replyTo && (
            <div className="mt-2">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
                {t.rich("replyingTo", { name: replyTo.mine ? t("you") : replyTo.user.username, b: (chunks) => <b className="font-bold text-fg">{chunks}</b> })}
              </p>
              <Composer
                key={replyTo.id}
                rows={1}
                spoilerSwitch={false}
                autoFocus
                label={t("replyLabel")}
                placeholder={t("replyPlaceholder")}
                submitLabel={t("reply")}
                onCancel={() => setReplying(null)}
                onSubmit={async (text) => {
                  const sent = await actions.reply(comment, text);
                  if (sent) {
                    setReplying(null);
                    setExpanded(true);
                  }
                  return sent;
                }}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
