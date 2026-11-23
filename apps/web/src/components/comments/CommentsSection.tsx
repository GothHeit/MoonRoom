"use client";

import { errorCode } from "@app/api-client";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import {
  COMMENT_MAX,
  COMMENTS_ANCHOR,
  COMMENTS_COUNT_EVENT,
  COMMENTS_FIRST,
  COMMENTS_PAGE,
  type CommentOut,
  type CommentsCountDetail,
  type CommentsPage,
  type TitleKind,
} from "@/lib/comments";
import { profileHref } from "@/lib/friends";
import { usePresence } from "@/lib/use-presence";

type Props = {
  kind: TitleKind;
  id: number;
  /** The first comments, loaded with the page; null when that failed and the browser should try. */
  initial: CommentsPage | null;
  /** The friends' progress line, rendered on the server. */
  friends: ReactNode;
};

type Result<T> = { data?: T; error?: unknown };

function list(kind: TitleKind, id: number, before: string | null, limit: number): Promise<Result<CommentsPage>> {
  const query = { limit, ...(before ? { before } : {}) };
  return kind === "anime"
    ? api.GET("/anime/{anime_id}/comments", { params: { path: { anime_id: id }, query } })
    : api.GET("/manga/{manga_id}/comments", { params: { path: { manga_id: id }, query } });
}

function create(kind: TitleKind, id: number, body: string, spoiler: boolean): Promise<Result<CommentOut>> {
  return kind === "anime"
    ? api.POST("/anime/{anime_id}/comments", { params: { path: { anime_id: id } }, body: { body, spoiler } })
    : api.POST("/manga/{manga_id}/comments", { params: { path: { manga_id: id } }, body: { body, spoiler } });
}

const icons = {
  lock: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  eyeOff: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.6 6.6A17 17 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  ),
  dots: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  ),
};

/** The text box with the spoiler switch, the counter and the send button. Used to write and to edit. */
function Composer({
  initialText = "",
  initialSpoiler = false,
  submitLabel,
  label,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  initialText?: string;
  initialSpoiler?: boolean;
  submitLabel: string;
  label: string;
  /** Resolves to true when saved, so the box can empty itself. */
  onSubmit: (text: string, spoiler: boolean) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const t = useTranslations("comments");
  const fieldId = useId();
  const [text, setText] = useState(initialText);
  const [spoiler, setSpoiler] = useState(initialSpoiler);
  const [busy, setBusy] = useState(false);
  const length = text.trim().length;
  const ready = length > 0 && length <= COMMENT_MAX && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    const saved = await onSubmit(text, spoiler);
    setBusy(false);
    if (saved && !onCancel) {
      setText("");
      setSpoiler(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-ui border border-line-strong bg-surface p-3 focus-within:border-accent">
      <label htmlFor={fieldId} className="sr-only">
        {label}
      </label>
      <textarea
        id={fieldId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          if (e.key === "Escape" && onCancel) onCancel();
        }}
        rows={3}
        maxLength={COMMENT_MAX + 200}
        placeholder={t("placeholder")}
        autoFocus={autoFocus}
        className="block min-h-[4.5rem] w-full resize-none bg-transparent text-base leading-normal text-fg outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          aria-pressed={spoiler}
          onClick={() => setSpoiler((v) => !v)}
          className={`press inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-bold ${
            spoiler ? "border-accent bg-line text-accent" : "border-line-strong text-fg hover:border-accent"
          }`}
        >
          {icons.eyeOff}
          {t("spoiler")}
        </button>
        <span className={`ml-auto text-xs tabular-nums ${length > COMMENT_MAX ? "text-danger" : "text-muted"}`} aria-live="polite">
          {t("counter", { count: length, max: COMMENT_MAX })}
        </span>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        )}
        <Button type="submit" variant={ready ? "primary" : "secondary"} disabled={!ready} className="disabled:border-line disabled:text-muted disabled:opacity-100">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The ⋯ menu on your own comments. */
function OwnMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const t = useTranslations("comments");
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "block w-full px-3 py-2 text-left text-sm hover:bg-bg active:bg-bg pointer-coarse:py-3";
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={root} className="relative -mr-3 -mt-2.5 shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("menu")}
        onClick={() => setOpen((v) => !v)}
        className="press flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg"
      >
        {icons.dots}
      </button>
      {presence.mounted && (
        <ul
          role="menu"
          data-closing={presence.closing || undefined}
          inert={presence.closing}
          className="pop-in absolute right-1 top-11 z-20 w-40 origin-top-right overflow-hidden rounded-ui border border-line bg-surface"
        >
          <li role="none">
            <button role="menuitem" type="button" className={item} onClick={pick(onEdit)}>
              {t("edit")}
            </button>
          </li>
          <li role="none" className="border-t border-line">
            <button role="menuitem" type="button" className={`${item} text-danger`} onClick={pick(onDelete)}>
              {t("delete")}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function Comment({
  comment,
  onSave,
  onDelete,
}: {
  comment: CommentOut;
  onSave: (text: string, spoiler: boolean) => Promise<boolean>;
  onDelete: () => void;
}) {
  const t = useTranslations("comments");
  const format = useFormatter();
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const hidden = comment.spoiler && !comment.mine && !revealed;
  // Never "in 2 seconds" when this device's clock runs behind the server's.
  const now = new Date();
  const created = new Date(Math.min(Date.parse(comment.created_at), now.getTime()));

  return (
    <li className="flex gap-3 border-b border-line py-4 last:border-b-0">
      <Link href={profileHref(comment.user.id)} aria-label={comment.user.username} className="press h-10 shrink-0 rounded-full">
        <Avatar userId={comment.user.id} username={comment.user.username} avatar={comment.user.avatar} size={40} />
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
          {comment.mine && !editing && <OwnMenu onEdit={() => setEditing(true)} onDelete={onDelete} />}
        </div>
        {editing ? (
          <div className="mt-2">
            <Composer
              initialText={comment.body}
              initialSpoiler={comment.spoiler}
              submitLabel={t("save")}
              label={t("editLabel")}
              autoFocus
              onCancel={() => setEditing(false)}
              onSubmit={async (text, spoiler) => {
                const saved = await onSave(text, spoiler);
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
          <p className="mt-1 whitespace-pre-line text-[15px] leading-relaxed text-soft [overflow-wrap:anywhere]">{comment.body}</p>
        )}
      </div>
    </li>
  );
}

/** Friends-only comments at the bottom of a title page: write box, newest first, "Show all". */
export function CommentsSection({ kind, id, initial, friends }: Props) {
  const t = useTranslations("comments");
  const tErr = useTranslations("errors");
  const toast = useToast();
  const [items, setItems] = useState<CommentOut[]>(initial?.items ?? []);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [next, setNext] = useState<string | null>(initial?.next ?? null);
  const [state, setState] = useState<"ready" | "loading" | "failed">(initial ? "ready" : "loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleting, setDeleting] = useState<CommentOut | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      const code = errorCode(error);
      toast(tErr.has(code) ? tErr(code) : t("actionFailed"), "error");
    },
    [t, tErr, toast],
  );

  const announce = useCallback(
    (count: number) => {
      setTotal(count);
      window.dispatchEvent(new CustomEvent<CommentsCountDetail>(COMMENTS_COUNT_EVENT, { detail: { kind, id, total: count } }));
    },
    [kind, id],
  );

  const apply = useCallback(
    (data: CommentsPage | undefined) => {
      if (!data) return setState("failed");
      setItems(data.items);
      setNext(data.next ?? null);
      announce(data.total);
      setState("ready");
    },
    [announce],
  );

  const load = useCallback(
    () =>
      list(kind, id, null, COMMENTS_FIRST).then(
        ({ data }) => apply(data),
        () => setState("failed"),
      ),
    [kind, id, apply],
  );

  // The page couldn't load them on the server: try once from here.
  useEffect(() => {
    if (initial) return;
    list(kind, id, null, COMMENTS_FIRST).then(
      ({ data }) => apply(data),
      () => setState("failed"),
    );
  }, [initial, kind, id, apply]);

  async function more() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const { data, error } = await list(kind, id, next, COMMENTS_PAGE);
      if (!data) return fail(error);
      setItems((current) => [...current, ...data.items.filter((c) => !current.some((o) => o.id === c.id))]);
      setNext(data.next ?? null);
      setTotal(data.total);
    } catch {
      toast(t("actionFailed"), "error");
    } finally {
      setLoadingMore(false);
    }
  }

  async function post(text: string, spoiler: boolean) {
    try {
      const { data, error } = await create(kind, id, text, spoiler);
      if (!data) {
        fail(error);
        return false;
      }
      setItems((current) => [data, ...current]);
      announce(total + 1);
      return true;
    } catch {
      toast(t("actionFailed"), "error");
      return false;
    }
  }

  async function save(comment: CommentOut, text: string, spoiler: boolean) {
    try {
      const { data, error } = await api.PATCH("/comments/{comment_id}", {
        params: { path: { comment_id: comment.id } },
        body: { body: text, spoiler },
      });
      if (!data) {
        fail(error);
        return false;
      }
      setItems((current) => current.map((c) => (c.id === data.id ? data : c)));
      return true;
    } catch {
      toast(t("actionFailed"), "error");
      return false;
    }
  }

  async function remove(comment: CommentOut) {
    try {
      const { error, response } = await api.DELETE("/comments/{comment_id}", { params: { path: { comment_id: comment.id } } });
      if (!response.ok && response.status !== 404) return fail(error);
      setItems((current) => current.filter((c) => c.id !== comment.id));
      announce(Math.max(0, total - 1));
      setDeleting(null);
      toast(t("deleted"), "success");
    } catch {
      toast(t("actionFailed"), "error");
    }
  }

  const hiddenCount = total - items.length;

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
        <Composer submitLabel={t("post")} label={t("label")} onSubmit={post} />
      </div>

      {state === "loading" && (
        <p className="mt-6 text-sm text-muted" role="status">
          {t("loading")}
        </p>
      )}
      {state === "failed" && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <p className="text-sm text-soft">{t("failed")}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setState("loading");
              void load();
            }}
          >
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
      {items.length > 0 && (
        <ul className="mt-2">
          {items.map((c) => (
            <Comment key={c.id} comment={c} onSave={(text, spoiler) => save(c, text, spoiler)} onDelete={() => setDeleting(c)} />
          ))}
        </ul>
      )}
      {next && hiddenCount > 0 && (
        <Button variant="secondary" className="mt-1" disabled={loadingMore} onClick={() => void more()}>
          {items.length <= COMMENTS_FIRST ? t("showAll", { count: total }) : t("showMore")}
        </Button>
      )}

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={t("deleteTitle")}>
        <p className="text-soft">{t("deleteBody")}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            {t("cancel")}
          </Button>
          <Button variant="secondary" className="text-danger hover:border-danger" onClick={() => deleting && void remove(deleting)}>
            {t("delete")}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
